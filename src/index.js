const BACKEND_KEY = "active_backend";
const MAX_PROMPT_LENGTH = 1000;
const DEFAULT_BACKEND_TTL = 7200;

export function allowedUser(env, userId) {
  const configured = (env.ALLOWED_TELEGRAM_USER_IDS || "").trim();
  if (!configured) return true;
  return configured.split(",").map((value) => value.trim()).includes(String(userId));
}

export function parseCommand(text = "") {
  const [raw = "", ...rest] = text.trim().split(/\s+/);
  return {
    command: raw.split("@")[0].toLowerCase(),
    argument: rest.join(" "),
  };
}

export function validateGenerate(input) {
  if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("prompt is required");
  }
  if (input.prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error("prompt is too long");
  }

  const bounded = (value, fallback, minimum, maximum) => {
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`value must be between ${minimum} and ${maximum}`);
    }
    return number;
  };

  return {
    prompt: input.prompt.trim(),
    negative_prompt: String(input.negative_prompt || "").slice(0, MAX_PROMPT_LENGTH),
    width: bounded(input.width, 1024, 512, 1024),
    height: bounded(input.height, 1024, 512, 1024),
    steps: bounded(input.steps, 25, 10, 40),
    guidance_scale: bounded(input.guidance_scale, 7, 1, 15),
    ip_adapter_scale: bounded(input.ip_adapter_scale, 0.6, 0, 1),
    seed: bounded(input.seed, -1, -1, 2147483647),
  };
}

async function telegram(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reply(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

// Inline keyboard linking to the Colab notebook so the user can cold-start the
// free backend with one tap. COLAB_NOTEBOOK_URL is an optional [vars] entry.
function colabButton(env) {
  const url = (env.COLAB_NOTEBOOK_URL || "").trim();
  if (!url) return {};
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "▶️ Open Colab backend", url }]],
    },
  };
}

// Telegram Mini App button opening the Gradio UI served on the live backend
// tunnel at `<backend.url>/app`. web_app requires an https URL (the Cloudflare
// Quick Tunnel is https) and only renders in private chats.
export function miniAppButton(backend) {
  if (!backend?.url) return {};
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "🎨 Open Web App", web_app: { url: `${backend.url}/app` } },
      ]],
    },
  };
}

async function activeBackend(env) {
  const record = await env.BACKEND_KV.get(BACKEND_KEY, "json");
  if (!record || record.expires_at <= Date.now()) return null;

  try {
    const response = await fetch(`${record.url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? record : null;
  } catch {
    return null;
  }
}

async function registerBackend(request, env) {
  if (request.headers.get("authorization") !== `Bearer ${env.REGISTRATION_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  let url;
  try {
    url = new URL(body.url);
  } catch {
    return Response.json({ error: "invalid URL" }, { status: 400 });
  }

  if (url.protocol !== "https:") {
    return Response.json({ error: "HTTPS required" }, { status: 400 });
  }

  const ttl = Math.min(
    Math.max(Number(body.ttl_seconds || DEFAULT_BACKEND_TTL), 60),
    21600,
  );
  const record = {
    url: url.origin,
    expires_at: Date.now() + ttl * 1000,
  };

  await env.BACKEND_KV.put(BACKEND_KEY, JSON.stringify(record), {
    expirationTtl: ttl,
  });
  return Response.json({ ok: true, ...record });
}

async function webhook(request, env, ctx) {
  if (
    request.headers.get("x-telegram-bot-api-secret-token") !==
    env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message?.text) return Response.json({ ok: true });

  const chatId = message.chat.id;
  if (!allowedUser(env, message.from?.id)) {
    ctx.waitUntil(reply(env, chatId, "Access denied."));
    return Response.json({ ok: true });
  }

  const { command, argument } = parseCommand(message.text);
  let task;

  if (command === "/start" || command === "/help") {
    task = (async () => {
      const backend = await activeBackend(env);
      // Prefer the Mini App button when a backend is live; otherwise offer the
      // Colab cold-start link.
      const buttons = backend ? miniAppButton(backend) : colabButton(env);
      return reply(
        env,
        chatId,
        "Commands:\n/status\n/generate <prompt>\n\nThe free Colab backend must be started manually before generation. When it is online, tap the button below to open the web app.",
        buttons,
      );
    })();
  } else if (command === "/status") {
    task = activeBackend(env).then((backend) =>
      backend
        ? reply(env, chatId, "Backend is online. Tap below to open the web app.", miniAppButton(backend))
        : reply(
            env,
            chatId,
            "Backend is offline. Tap below to start the Colab notebook, run the cells, then retry.",
            colabButton(env),
          ),
    );
  } else if (command === "/generate") {
    task = (async () => {
      let payload;
      try {
        payload = validateGenerate({ prompt: argument });
      } catch (error) {
        return reply(env, chatId, `Invalid request: ${error.message}`);
      }

      const backend = await activeBackend(env);
      if (!backend) {
        return reply(
          env,
          chatId,
          "Generation is offline. Tap below to start the Colab notebook, run the cells, then retry.",
          colabButton(env),
        );
      }

      // Attach the chat id so the backend delivers the finished PNG directly
      // via sendPhoto — the Worker cannot hold a request open long enough to
      // poll for a multi-second SDXL generation.
      const response = await fetch(`${backend.url}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, chat_id: chatId }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return reply(env, chatId, "The backend rejected the generation request.");
      }

      await response.json();
      return reply(
        env,
        chatId,
        "Generating your image — it will arrive here shortly.",
      );
    })();
  } else {
    task = reply(env, chatId, "Unknown command. Use /help.");
  }

  ctx.waitUntil(task);
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/register-backend") {
      return registerBackend(request, env);
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return webhook(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
