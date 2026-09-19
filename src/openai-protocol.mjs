import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.mjs";

export function normalizeOpenAIRequest(pathname, body) {
  if (pathname.endsWith("/chat/completions")) return normalizeChat(body);
  if (pathname.endsWith("/responses")) return normalizeResponses(body);
  throw new BridgeError(`Unsupported OpenAI endpoint: ${pathname}`, 404);
}

export function createSink(protocol, response, { stream = false, onLifecycle = () => {} } = {}) {
  return protocol === "responses"
    ? new ResponsesSink(response, stream, onLifecycle)
    : new ChatCompletionsSink(response, stream, onLifecycle);
}

export function sendJson(response, status, value) {
  if (response.headersSent) return;
  const json = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
}

export function sendOpenAIError(response, error) {
  const status = Number.isInteger(error?.status)
    ? error.status
    : Number(error?.details?.code) === -32602 ? 400 : 500;
  const payload = {
    error: {
      message: error?.message || "Bridge request failed",
      type: status === 401 ? "authentication_error" : "bridge_error",
      param: null,
      code: error?.details?.code || null,
    },
  };
  if (!response.headersSent) sendJson(response, status, payload);
  else if (!response.writableEnded) response.end();
}

function normalizeChat(body = {}) {
  const instructions = [];
  const transcript = [];
  const toolResults = [];
  const images = [];
  for (const message of body.messages || []) {
    const role = message?.role || "user";
    if (role === "system" || role === "developer") {
      instructions.push(extractContent(message.content, images));
      continue;
    }
    if (role === "tool") {
      if (message.tool_call_id) {
        toolResults.push({
          callId: message.tool_call_id,
          output: extractContent(message.content),
          isError: false,
        });
      }
      transcript.push(`[tool ${message.name || message.tool_call_id || "result"}]\n${extractContent(message.content)}`);
      continue;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        transcript.push(`[assistant requested tool ${call.function?.name || "unknown"}]\n${call.function?.arguments || "{}"}`);
      }
    }
    const content = extractContent(message.content, images);
    if (content) transcript.push(`[${role}]\n${content}`);
  }
  return {
    protocol: "chat",
    model: body.model,
    stream: Boolean(body.stream),
    effort: body.reasoning_effort || body.reasoning?.effort,
    instructions: instructions.filter(Boolean).join("\n\n"),
    prompt: transcript.join("\n\n"),
    tools: body.tools || [],
    toolResults,
    images,
  };
}

function normalizeResponses(body = {}) {
  const images = [];
  const instructions = [extractContent(body.instructions, images)].filter(Boolean);
  const transcript = [];
  const toolResults = [];
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : (body.input || []);
  for (const item of input) {
    if (item?.type === "function_call_output") {
      toolResults.push({
        callId: item.call_id,
        output: item.output,
        isError: false,
      });
      transcript.push(`[tool ${item.call_id}]\n${extractContent(item.output)}`);
      continue;
    }
    if (item?.type === "function_call") {
      transcript.push(`[assistant requested tool ${item.name || "unknown"}]\n${item.arguments || "{}"}`);
      continue;
    }
    const role = item?.role || "user";
    if (role === "system" || role === "developer") {
      instructions.push(extractContent(item.content));
    } else {
      const content = extractContent(item.content ?? item, images);
      if (content) transcript.push(`[${role}]\n${content}`);
    }
  }
  return {
    protocol: "responses",
    model: body.model,
    stream: Boolean(body.stream),
    effort: body.reasoning?.effort || body.reasoning_effort,
    instructions: instructions.filter(Boolean).join("\n\n"),
    prompt: transcript.join("\n\n"),
    tools: body.tools || [],
    toolResults,
    images,
    previousResponseId: body.previous_response_id || null,
  };
}

function extractContent(content, images = null) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) return content.map((item) => extractContent(item, images)).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (content.type === "image_url" || content.type === "input_image") {
      const source = content.image_url?.url || content.image_url || content.url;
      if (images && typeof source === "string" && source) {
        images.push({ source });
        return `[image ${images.length} attached]`;
      }
      return "[image attached]";
    }
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (typeof content.output_text === "string") return content.output_text;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

class ChatCompletionsSink {
  constructor(response, stream, onLifecycle) {
    this.response = response;
    this.stream = stream;
    this.closed = false;
    this.textValue = "";
    this.toolCalls = [];
    this.id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = null;
    this.onLifecycle = onLifecycle;
  }

  open(session) {
    this.session = session;
    this.model = session.model;
    if (!this.stream) return;
    openSse(this.response);
    this.#chunk({ role: "assistant", content: "" }, null);
  }

  text(delta) {
    if (this.closed || !delta) return;
    this.textValue += delta;
    if (this.stream) this.#chunk({ content: delta }, null);
  }

  tool(call) {
    if (this.closed) return;
    const index = this.toolCalls.length;
    const value = {
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    };
    this.toolCalls.push(value);
    if (this.stream) this.#chunk({ tool_calls: [{ index, ...value }] }, null);
  }

  completeForTool() {
    if (this.closed) return;
    if (this.stream) {
      this.#chunk({}, "tool_calls");
      this.response.write("data: [DONE]\n\n");
      this.response.end();
    } else {
      sendJson(this.response, 200, this.#body("tool_calls"));
    }
    this.closed = true;
    this.onLifecycle({ status: "tool_requested" });
  }

  complete() {
    if (this.closed) return;
    if (this.stream) {
      this.#chunk({}, "stop");
      this.response.write("data: [DONE]\n\n");
      this.response.end();
    } else {
      sendJson(this.response, 200, this.#body("stop"));
    }
    this.closed = true;
    this.onLifecycle({ status: "succeeded" });
  }

  error(error) {
    if (this.closed) return;
    if (!this.response.headersSent) sendOpenAIError(this.response, error);
    else {
      this.response.write(`data: ${JSON.stringify({ error: { message: error.message, type: "bridge_error" } })}\n\n`);
      this.response.write("data: [DONE]\n\n");
      this.response.end();
    }
    this.closed = true;
    this.onLifecycle({ status: "failed", error });
  }

  #chunk(delta, finishReason) {
    this.response.write(`data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      ...(finishReason && this.session?.usage ? { usage: chatUsage(this.session.usage) } : {}),
    })}\n\n`);
  }

  #body(finishReason) {
    const message = { role: "assistant", content: this.textValue || null };
    if (this.toolCalls.length) message.tool_calls = this.toolCalls;
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
      usage: this.session?.usage ? chatUsage(this.session.usage) : zeroUsage(),
    };
  }
}

class ResponsesSink {
  constructor(response, stream, onLifecycle) {
    this.response = response;
    this.stream = stream;
    this.closed = false;
    this.textValue = "";
    this.output = [];
    this.sequence = 0;
    this.responseId = null;
    this.messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    this.model = null;
    this.messageOpened = false;
    this.messageClosed = false;
    this.onLifecycle = onLifecycle;
  }

  open(session) {
    this.session = session;
    this.model = session.model;
    this.responseId = session.responseId;
    if (!this.stream) return;
    openSse(this.response);
    this.#event("response.created", { response: this.#response("in_progress") });
    this.#event("response.in_progress", { response: this.#response("in_progress") });
  }

  text(delta) {
    if (this.closed || !delta) return;
    this.#openMessage();
    this.textValue += delta;
    if (this.stream) this.#event("response.output_text.delta", {
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  tool(call) {
    if (this.closed) return;
    this.#closeMessage();
    const item = {
      type: "function_call",
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
      status: "completed",
    };
    const outputIndex = this.output.length;
    this.output.push(item);
    if (this.stream) {
      this.#event("response.output_item.added", { output_index: outputIndex, item: { ...item, arguments: "", status: "in_progress" } });
      this.#event("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments });
      this.#event("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
      this.#event("response.output_item.done", { output_index: outputIndex, item });
    }
  }

  completeForTool() {
    this.#finish("tool_requested");
  }

  complete() {
    this.#finish("succeeded");
  }

  error(error) {
    if (this.closed) return;
    if (!this.response.headersSent) sendOpenAIError(this.response, error);
    else {
      this.#event("error", { type: "error", code: "bridge_error", message: error.message, param: null });
      this.response.end();
    }
    this.closed = true;
    this.onLifecycle({ status: "failed", error });
  }

  #finish(status) {
    if (this.closed) return;
    this.#closeMessage();
    const body = this.#response("completed");
    if (this.stream) {
      this.#event("response.completed", { response: body });
      this.response.write("data: [DONE]\n\n");
      this.response.end();
    } else {
      sendJson(this.response, 200, body);
    }
    this.closed = true;
    this.onLifecycle({ status });
  }

  #openMessage() {
    if (this.messageOpened) return;
    this.messageOpened = true;
    const item = { id: this.messageId, type: "message", status: "in_progress", role: "assistant", content: [] };
    if (this.stream) {
      this.#event("response.output_item.added", { output_index: 0, item });
      this.#event("response.content_part.added", {
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
    }
  }

  #closeMessage() {
    if (!this.messageOpened || this.messageClosed) return;
    this.messageClosed = true;
    const part = { type: "output_text", text: this.textValue, annotations: [], logprobs: [] };
    const item = { id: this.messageId, type: "message", status: "completed", role: "assistant", content: [part] };
    this.output.unshift(item);
    if (this.stream) {
      this.#event("response.output_text.done", { item_id: this.messageId, output_index: 0, content_index: 0, text: this.textValue, logprobs: [] });
      this.#event("response.content_part.done", { item_id: this.messageId, output_index: 0, content_index: 0, part });
      this.#event("response.output_item.done", { output_index: 0, item });
    }
  }

  #response(status) {
    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      background: false,
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: this.model,
      output: status === "completed" ? this.output : [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: status === "completed" ? {
        input_tokens: this.session?.usage?.inputTokens || 0,
        input_tokens_details: { cached_tokens: this.session?.usage?.cachedTokens || 0 },
        output_tokens: this.session?.usage?.outputTokens || 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: (this.session?.usage?.inputTokens || 0) + (this.session?.usage?.outputTokens || 0),
      } : null,
      user: null,
      metadata: {},
    };
  }

  #event(type, data) {
    this.response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`);
  }
}

function openSse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();
}

function zeroUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
}

function chatUsage(usage) {
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
}
