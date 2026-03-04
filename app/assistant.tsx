"use client";

import { useEffect } from "react";
import { AssistantRuntimeProvider, ChatModelAdapter, useAui, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";

type HumanInputPayload = {
  type: "proceed" | "reject";
  startNodeId: string;
  feedback: string;
};

type FlowiseSuggestion = {
  title: string;
  label: string;
  prompt: string;
  source?: "humanInputAction";
  humanInput?: HumanInputPayload;
};

const pendingHumanInputByPrompt = new Map<string, HumanInputPayload>();
const FLOWISE_CHATFLOW_ID = "28d6433e-ad27-45a4-b9d5-c23b7104d108";
const FLOWISE_API_HOST = "http://94.130.186.85:3000";
const FLOWISE_API_KEY = process.env.NEXT_PUBLIC_FLOWISE_API_KEY ?? "";

const getOrCreateChatId = (chatflowId: string): string => {
  const storageKey = `${chatflowId}`;

  if (typeof window !== "undefined") {
    const existingChatId = window.localStorage.getItem(storageKey);
    if (existingChatId) {
      try {
        const parsed = JSON.parse(existingChatId) as { chatId?: unknown };
        if (typeof parsed?.chatId === "string" && parsed.chatId) {
          return parsed.chatId;
        }
      } catch {
        if (existingChatId) {
          return existingChatId;
        }
      }
    }

    const generatedChatId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    window.localStorage.setItem(storageKey, JSON.stringify({ chatId: generatedChatId }));
    return generatedChatId;
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const resolveHumanInputType = (key: string, actionType: unknown): HumanInputPayload["type"] => {
  if (actionType === "proceed" || actionType === "reject") {
    return actionType;
  }

  return key.toLowerCase().includes("reject") ? "reject" : "proceed";
};

const getSuggestions = (data: any): FlowiseSuggestion[] => {
  const executedData = data?.agentFlowExecutedData;
  const lastExecutedData = Array.isArray(executedData)
    ? executedData[executedData.length - 1]
    : undefined;

  console.log("Last executed data:", lastExecutedData);
  if (!lastExecutedData) return [];

  const humanInputAction = lastExecutedData?.data?.output?.humanInputAction;
  const mapping = humanInputAction?.mapping || {};

  if (Object.keys(mapping).length === 0) {
    console.warn("No valid mapping found in the response:", lastExecutedData);
    return [];
  }

  const startNodeId = humanInputAction?.data?.nodeId || "";

  return Object.keys(mapping).map((key) => {
    const label = String(mapping[key]);
    const type = resolveHumanInputType(key, humanInputAction?.type);

    return {
      title: key,
      label,
      prompt: label,
      source: "humanInputAction" as const,
      humanInput: {
        type,
        startNodeId,
        feedback: "",
      },
    };
  });
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = extractText(item);
      if (resolved) return resolved;
    }
    return "";
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.text === "string") return candidate.text;
    if (typeof candidate.content === "string") return candidate.content;
    if (typeof candidate.message === "string") return candidate.message;
  }

  return "";
};

const toRuntimeMessage = (role: "user" | "assistant", text: string) => ({
  role,
  content: [{ type: "text" as const, text }],
});

const mapFlowiseHistoryToMessages = (payload: unknown) => {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : [];

  const mapped: Array<ReturnType<typeof toRuntimeMessage>> = [];

  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.toLowerCase() : "";

    if (role === "user" || role === "human" || role === "usermessage" || role === "humanmessage") {
      const text = extractText(record.content ?? record.message ?? record.text);
      if (text.trim()) mapped.push(toRuntimeMessage("user", text));
      continue;
    }

    if (role === "assistant" || role === "ai" || role === "apimessage" || role === "aimessage") {
      const text = extractText(record.content ?? record.message ?? record.text);
      if (text.trim()) mapped.push(toRuntimeMessage("assistant", text));
      continue;
    }

    const question = extractText(record.question ?? record.userMessage ?? record.input);
    if (question.trim()) mapped.push(toRuntimeMessage("user", question));

    const answer = extractText(record.content ?? record.text ?? record.response ?? record.assistantMessage ?? record.output);
    if (answer.trim()) mapped.push(toRuntimeMessage("assistant", answer));
  }

  return mapped;
};

const flowiseAdapter: ChatModelAdapter = {

  async *run({ messages, abortSignal }) {
    const lastMessage = messages[messages.length - 1];
    const textContent = lastMessage.content.find((c) => c.type === "text");
    const questionText = textContent && "text" in textContent ? textContent.text : "";
    const normalizedQuestion = questionText.trim();

    const matchedHumanInput = pendingHumanInputByPrompt.get(normalizedQuestion);
    if (matchedHumanInput) {
      pendingHumanInputByPrompt.delete(normalizedQuestion);
    }

    const chatId = getOrCreateChatId(FLOWISE_CHATFLOW_ID);

    const requestBody: Record<string, unknown> = {
      chatId,
      question: questionText,
    };

    if (matchedHumanInput) {
      requestBody.humanInput = matchedHumanInput;
      // requestBody.streaming = true;
      console.log("Sending humanInput payload:", matchedHumanInput);
    }
    
    const response = await fetch(`${FLOWISE_API_HOST}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FLOWISE_API_KEY}`,
      },
      signal: abortSignal,
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    console.log("Flowise response:", data);

    const assistantText = typeof data?.text === "string" ? data.text : "";

    const suggestions = getSuggestions(data);
    console.log("Flowise suggestions:", suggestions);

    pendingHumanInputByPrompt.clear();
    for (const suggestion of suggestions) {
      const promptKey = suggestion.prompt?.trim();
      if (!promptKey || !suggestion.humanInput) continue;
      pendingHumanInputByPrompt.set(promptKey, suggestion.humanInput);
    }

    // Yield the response back to assistant-ui
    yield {
      content: [{ type: "text", text: assistantText }],
      metadata: {
        custom: {
          flowiseSuggestions: suggestions,
        },
      },
    };
  },
};

export const Assistant = () => {
  const runtime = useLocalRuntime(flowiseAdapter, {
    adapters: {
      suggestion: {
        async generate({ messages }) {
          const lastAssistantMessage = [...messages]
            .reverse()
            .find((message) => message.role === "assistant");

          const rawSuggestions = lastAssistantMessage?.metadata?.custom?.flowiseSuggestions;
          if (!Array.isArray(rawSuggestions)) return [];

          return rawSuggestions
            .map((suggestion) => {
              if (typeof suggestion === "string") {
                return { title: suggestion, label: suggestion, prompt: suggestion };
              }

              if (typeof suggestion === "object" && suggestion !== null && "prompt" in suggestion) {
                const prompt = typeof suggestion.prompt === "string" ? suggestion.prompt : "";
                if (!prompt) return null;

                const title = typeof suggestion.title === "string" ? suggestion.title : prompt;
                const label = typeof suggestion.label === "string" ? suggestion.label : prompt;

                return {
                  ...suggestion,
                  title,
                  label,
                  prompt,
                };
              }

              return null;
            })
            .filter((suggestion): suggestion is { title: string; label: string; prompt: string } => suggestion !== null);
        },
      },
    },
  });

  useEffect(() => {
    const controller = new AbortController();

    const loadInitialMessages = async () => {
      try {
        const chatId = getOrCreateChatId(FLOWISE_CHATFLOW_ID);
        const historyUrl = `${FLOWISE_API_HOST}/api/v1/chatmessage/${FLOWISE_CHATFLOW_ID}?chatId=${encodeURIComponent(chatId)}`;

        const response = await fetch(historyUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${FLOWISE_API_KEY}`,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          console.warn("Failed to fetch Flowise chat history:", response.status);
          return;
        }

        const payload = await response.json();
        const initialMessages = mapFlowiseHistoryToMessages(payload);

        if (initialMessages.length > 0) {
          runtime.thread.reset(initialMessages);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Error loading Flowise chat history:", error);
      }
    };

    loadInitialMessages();

    return () => {
      controller.abort();
    };
  }, [runtime]);

  const aui = useAui({});
  

  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      <div className="h-screen w-full border bg-white p-4">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
};

