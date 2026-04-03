"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Card, Button, Badge, Toggle } from "@/shared/components";

const DEFAULT_SYSTEM = "You are a helpful assistant.";

export default function PlaygroundPage() {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState("");
  const [loading, setLoading] = useState(false);

  const [inspector, setInspector] = useState(null);
  const [inspectorTab, setInspectorTab] = useState("meta");
  const [showInspector, setShowInspector] = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const dropdownRef = useRef(null);

  useEffect(() => {
    fetch("/api/v1/models")
      .then((r) => r.json())
      .then((d) => {
        const list = (d.data || []).sort((a, b) => a.id.localeCompare(b.id));
        setModels(list);
        if (list.length > 0 && !model) setModel(list[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const grouped = models.reduce((acc, m) => {
    const provider = m.owned_by || m.id.split("/")[0] || "other";
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(m);
    return acc;
  }, {});

  const filtered = search.trim()
    ? Object.fromEntries(
        Object.entries(grouped)
          .map(([k, v]) => [k, v.filter((m) => m.id.toLowerCase().includes(search.toLowerCase()))])
          .filter(([, v]) => v.length > 0)
      )
    : grouped;

  const buildRequestBody = (msgs) => {
    const body = {
      model,
      messages: [
        ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt }] : []),
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: streaming,
      temperature: parseFloat(temperature),
    };
    if (maxTokens && parseInt(maxTokens) > 0) body.max_tokens = parseInt(maxTokens);
    return body;
  };

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !model || loading) return;

    const userMsg = { role: "user", content: text };
    const assistantMsg = { role: "assistant", content: "", loading: true };
    const newMsgs = [...messages, userMsg, assistantMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);
    inputRef.current?.focus();

    const requestBody = buildRequestBody([...messages, userMsg]);
    const startTime = performance.now();

    const controller = new AbortController();
    abortRef.current = controller;

    const meta = { model, ttfb: null, totalMs: null, tokens: null, status: null, error: null };

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      meta.status = res.status;
      meta.ttfb = Math.round(performance.now() - startTime);

      if (!res.ok) {
        const err = await res.text();
        meta.error = err;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: `Error ${res.status}: ${err}`, error: true };
          return copy;
        });
        setInspector({ request: requestBody, meta });
        setShowInspector(true);
        return;
      }

      if (streaming) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content || "";
              full += delta;
              if (chunk.usage) meta.tokens = chunk.usage;
            } catch {}
          }

          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", content: full };
            return copy;
          });
        }
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || JSON.stringify(data);
        meta.tokens = data.usage || null;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content };
          return copy;
        });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.loading && !last.content) copy.pop();
          return copy;
        });
        return;
      }
      meta.error = err.message;
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: `Network error: ${err.message}`, error: true };
        return copy;
      });
    } finally {
      meta.totalMs = Math.round(performance.now() - startTime);
      abortRef.current = null;
      setLoading(false);
      setInspector({ request: requestBody, meta });
      setShowInspector(true);
    }
  }, [input, model, messages, loading, streaming, temperature, maxTokens, systemPrompt]);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    setMessages([]);
    setInspector(null);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyCurl = () => {
    if (!inspector?.request) return;
    const curl = `curl -X POST http://localhost:20128/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(inspector.request)}'`;
    navigator.clipboard.writeText(curl);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Toolbar */}
      <div className="shrink-0 p-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-text-main">Playground</h1>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon="delete" onClick={handleClear}>Clear</Button>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Model picker */}
          <div className="relative flex-1 min-w-[240px] max-w-md" ref={dropdownRef}>
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => setShowDropdown(!showDropdown)}
            >
              <span className="material-symbols-outlined text-[16px] text-text-muted">smart_toy</span>
              <span className="truncate text-text-main font-mono text-xs">{model || "Select model"}</span>
              <span className="material-symbols-outlined text-[16px] text-text-muted ml-auto">expand_more</span>
            </div>
            {showDropdown && (
              <div className="absolute z-50 top-full mt-1 w-full max-h-80 overflow-auto bg-surface border border-black/10 dark:border-white/10 rounded-lg shadow-xl">
                <div className="sticky top-0 bg-surface p-2 border-b border-black/5 dark:border-white/5">
                  <input
                    type="text"
                    placeholder="Search models..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-transparent border border-black/10 dark:border-white/10 rounded text-text-main placeholder-text-muted/60 focus:outline-none focus:border-primary/50"
                    autoFocus
                  />
                </div>
                {Object.entries(filtered).map(([provider, providerModels]) => (
                  <div key={provider}>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase text-text-muted/60 tracking-wider bg-black/[0.02] dark:bg-white/[0.02]">
                      {provider} ({providerModels.length})
                    </div>
                    {providerModels.map((m) => (
                      <button
                        key={m.id}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate hover:bg-primary/10 transition-colors ${m.id === model ? "bg-primary/10 text-primary" : "text-text-main"}`}
                        onClick={() => { setModel(m.id); setShowDropdown(false); setSearch(""); }}
                      >
                        {m.id}
                      </button>
                    ))}
                  </div>
                ))}
                {Object.keys(filtered).length === 0 && (
                  <div className="p-4 text-center text-xs text-text-muted">No models found</div>
                )}
              </div>
            )}
          </div>

          {/* Params */}
          <div className="flex items-center gap-3 text-xs">
            <Toggle checked={streaming} onChange={setStreaming} label="Stream" size="sm" />

            <div className="flex items-center gap-1.5">
              <span className="text-text-muted">Temp</span>
              <input
                type="number" min="0" max="2" step="0.1" value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-14 px-1.5 py-1 text-xs bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded text-text-main text-center focus:outline-none focus:border-primary/50"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-text-muted">Max</span>
              <input
                type="number" min="1" step="100" value={maxTokens} placeholder="∞"
                onChange={(e) => setMaxTokens(e.target.value)}
                className="w-16 px-1.5 py-1 text-xs bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded text-text-main text-center focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>
        </div>

        {/* System prompt */}
        <details className="group">
          <summary className="flex items-center gap-1.5 cursor-pointer text-xs text-text-muted hover:text-text-main transition-colors select-none">
            <span className="material-symbols-outlined text-[14px] group-open:rotate-90 transition-transform">chevron_right</span>
            System prompt
            {systemPrompt !== DEFAULT_SYSTEM && <Badge size="sm" variant="primary">edited</Badge>}
          </summary>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={2}
            className="mt-2 w-full px-3 py-2 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md text-text-main placeholder-text-muted/60 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y"
            placeholder="System prompt..."
          />
        </details>
      </div>

      {/* Chat + Inspector */}
      <div className="flex flex-1 min-h-0 gap-0">
        {/* Messages */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center text-text-muted/50">
                  <span className="material-symbols-outlined text-[48px] mb-2 block">chat</span>
                  <p className="text-sm">Send a message to test <span className="font-mono text-primary text-xs">{model}</span></p>
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <MessageBubble key={i} msg={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 p-4 pt-2 border-t border-black/5 dark:border-white/5">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
                className="flex-1 px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg text-text-main placeholder-text-muted/60 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
                style={{ minHeight: "40px", maxHeight: "120px" }}
                onInput={(e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
              />
              {loading ? (
                <Button size="md" variant="danger" icon="stop" onClick={handleStop}>Stop</Button>
              ) : (
                <Button size="md" icon="send" onClick={handleSend} disabled={!input.trim() || !model}>Send</Button>
              )}
            </div>
          </div>
        </div>

        {/* Inspector panel */}
        {showInspector && inspector && (
          <div className="w-80 shrink-0 border-l border-black/5 dark:border-white/5 flex flex-col bg-surface overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-black/5 dark:border-white/5">
              <span className="text-xs font-semibold text-text-main">Inspector</span>
              <button onClick={() => setShowInspector(false)} className="text-text-muted hover:text-text-main">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-black/5 dark:border-white/5">
              {["meta", "request", "curl"].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setInspectorTab(tab)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium capitalize transition-colors ${inspectorTab === tab ? "text-primary border-b-2 border-primary" : "text-text-muted hover:text-text-main"}`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto p-3 text-xs font-mono">
              {inspectorTab === "meta" && (
                <div className="space-y-2">
                  <MetaRow label="Model" value={inspector.meta.model} />
                  <MetaRow label="Status" value={inspector.meta.status} color={inspector.meta.status === 200 ? "green" : "red"} />
                  <MetaRow label="TTFB" value={inspector.meta.ttfb ? `${inspector.meta.ttfb}ms` : "—"} />
                  <MetaRow label="Total" value={inspector.meta.totalMs ? `${inspector.meta.totalMs}ms` : "—"} />
                  {inspector.meta.tokens && (
                    <>
                      <MetaRow label="Prompt tokens" value={inspector.meta.tokens.prompt_tokens} />
                      <MetaRow label="Completion tokens" value={inspector.meta.tokens.completion_tokens} />
                      <MetaRow label="Total tokens" value={inspector.meta.tokens.total_tokens} />
                    </>
                  )}
                  {inspector.meta.error && (
                    <div className="mt-2 p-2 bg-red-500/10 rounded text-red-500 text-[11px] break-all">{inspector.meta.error}</div>
                  )}
                </div>
              )}
              {inspectorTab === "request" && (
                <pre className="whitespace-pre-wrap break-all text-text-muted leading-relaxed">
                  {JSON.stringify(inspector.request, null, 2)}
                </pre>
              )}
              {inspectorTab === "curl" && (
                <div>
                  <Button size="sm" variant="outline" icon="content_copy" onClick={copyCurl} className="mb-2">Copy</Button>
                  <pre className="whitespace-pre-wrap break-all text-text-muted leading-relaxed">
                    {`curl -X POST http://localhost:20128/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(inspector.request)}'`}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
          isUser
            ? "bg-primary/10 text-text-main"
            : msg.error
              ? "bg-red-500/10 text-red-500 border border-red-500/20"
              : "bg-black/[0.03] dark:bg-white/[0.05] text-text-main"
        } ${msg.loading && !msg.content ? "animate-pulse" : ""}`}
      >
        {msg.loading && !msg.content ? (
          <span className="text-text-muted text-xs">Thinking...</span>
        ) : (
          msg.content
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value, color }) {
  const colorClass = color === "green" ? "text-green-500" : color === "red" ? "text-red-500" : "text-text-main";
  return (
    <div className="flex justify-between items-center py-1 border-b border-black/5 dark:border-white/5 last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className={`font-semibold ${colorClass}`}>{value ?? "—"}</span>
    </div>
  );
}
