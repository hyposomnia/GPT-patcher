#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const binary = process.argv[2];
const sourceCatalog = process.argv[3];
if (binary == null || sourceCatalog == null) {
  throw new Error("Usage: probe-lightweight.mjs <app-server> <models.json>");
}

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-patcher-probe-"));
const catalog = JSON.parse(fs.readFileSync(sourceCatalog, "utf8"));
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  throw new Error(`Invalid model catalog: ${sourceCatalog}`);
}
const model = catalog.models.find((candidate) => candidate.slug === "gpt-5.6-sol") ?? catalog.models[0];
model.use_responses_lite = false;
const catalogPath = path.join(temporaryHome, "models.json");
fs.writeFileSync(catalogPath, `${JSON.stringify({ models: [model] }, null, 2)}\n`);

let capturedRequest;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.url?.endsWith("/responses")) {
      capturedRequest = {
        body: JSON.parse(body),
        headers: request.headers,
        url: request.url,
      };
    }
    const events = [
      { type: "response.created", response: { id: "resp-probe" } },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "msg-probe",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp-probe",
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (typeof address !== "object" || address == null) throw new Error("Mock server did not bind");

const config = `model = ${JSON.stringify(model.slug)}
model_provider = "custom"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "live"

[features]
image_generation = true

[model_providers.custom]
name = "Probe custom provider"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = true
`;
fs.writeFileSync(path.join(temporaryHome, "config.toml"), config);

const child = spawn(
  binary,
  [
    "-c",
    'model_providers.custom.name="OpenAI"',
    "-c",
    "model_providers.custom.requires_openai_auth=false",
    "-c",
    'model_providers.custom.env_key="GPT_PATCHER_PROBE_KEY"',
    "-c",
    'model_providers.custom.http_headers.x-openai-actor-authorization="gpt-patcher-probe"',
    "-c",
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    "app-server",
    "--stdio",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: temporaryHome,
      GPT_PATCHER_PROBE_KEY: "probe-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id != null && ("result" in message || "error" in message)) {
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId;
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10_000);
    pending.set(String(id), (message) => {
      clearTimeout(timer);
      if (message.error != null) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
  });
}

try {
  await send("initialize", {
    clientInfo: { name: "gpt-patcher-probe", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const threadResult = await send("thread/start", {
    model: model.slug,
    modelProvider: "custom",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  await send("turn/start", {
    threadId: threadResult.thread.id,
    input: [{ type: "text", text: "Reply with done." }],
  });

  const deadline = Date.now() + 10_000;
  while (capturedRequest == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (capturedRequest == null) throw new Error(`No Responses request captured.\n${stderr}`);

  const tools = (capturedRequest.body.tools ?? []).map((tool) => ({
    name: tool.name ?? tool.function?.name ?? tool.namespace ?? null,
    type: tool.type ?? null,
  }));
  console.log(
    JSON.stringify(
      {
        authorization: capturedRequest.headers.authorization,
        actorAuthorization: capturedRequest.headers["x-openai-actor-authorization"],
        bodyContainsImageGeneration: JSON.stringify(capturedRequest.body).includes(
          "image_gen__imagegen",
        ),
        hasInstructions: typeof capturedRequest.body.instructions === "string",
        model: capturedRequest.body.model,
        responsesLiteHeader:
          capturedRequest.headers["x-openai-internal-codex-responses-lite"] ?? null,
        tools,
        url: capturedRequest.url,
      },
      null,
      2,
    ),
  );
} finally {
  child.kill("SIGTERM");
  server.close();
  fs.rmSync(temporaryHome, { force: true, recursive: true });
}
