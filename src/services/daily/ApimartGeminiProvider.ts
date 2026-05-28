import type { AIMessage, AIResponse } from '../../types/index.js';
import type { AIProvider } from '../AIProvider.js';

interface ApimartPart {
  text?: string;
}

interface ApimartGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: ApimartPart[];
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class ApimartGeminiProvider implements AIProvider {
  name = 'APIMart Gemini';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 45000
  ) {}

  async generateContent(prompt: string | AIMessage[], _tools: any[], systemInstruction?: string): Promise<AIResponse> {
    const text = typeof prompt === 'string'
      ? prompt
      : prompt.map((message) => `${message.role}: ${message.content || ''}`).join('\n\n');

    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: systemInstruction ? `${systemInstruction}\n\n${text}` : text,
          },
        ],
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/models/${this.model}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contents }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`APIMart Gemini error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as ApimartGenerateContentResponse;
    const content = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim() || '';

    return {
      content,
      usage: data.usageMetadata ? {
        prompt_tokens: data.usageMetadata.promptTokenCount || 0,
        completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata.totalTokenCount || 0,
      } : undefined,
    };
  }
}
