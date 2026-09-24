import { open, stat } from 'node:fs/promises';
import type { PaneUsage } from '../shared/types.js';

/**
 * API list prices in USD per million tokens. Cache writes are priced from `input`
 * (1.25x for the 5-minute TTL, 2x for the 1-hour one); cache reads are 0.1x `input`
 * unless a model sets its own rate. Matched against the model id in order, first hit wins.
 *
 * Only models with a price we are sure of are listed. Anything else still shows its token
 * counts; the pane just shows no cost for it.
 */
const PRICES: { match: RegExp; input: number; output: number; cacheRead?: number }[] = [
  { match: /fable-5-1|mythos-5-1/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /fable-5|mythos-5/, input: 10, output: 50 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  // The lookahead keeps opus-5 from matching a later opus-5-N; a date suffix still matches.
  { match: /opus-5(?!-\d\b)|opus-4-[678]/, input: 5, output: 25 },
  { match: /sonnet-5(?!-\d\b)/, input: 2, output: 10 },
  { match: /sonnet-4-6/, input: 3, output: 15 },
  { match: /haiku-4-5/, input: 1, output: 5 },
];

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface Entry {
  model?: string;
  usage: MessageUsage;
}

/** Cost of one message at list price, or undefined when its model has no known price. */
export function messageCost(model: string | undefined, u: MessageUsage): number | undefined {
  // Claude Code writes "<synthetic>" for messages it made up itself (errors, interrupts).
  if (model === '<synthetic>') return 0;
  const price = model ? PRICES.find((p) => p.match.test(model)) : undefined;
  if (!price) return undefined;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const tokens =
    (u.input_tokens ?? 0) * price.input +
    (u.output_tokens ?? 0) * price.output +
    (u.cache_read_input_tokens ?? 0) * (price.cacheRead ?? price.input * 0.1) +
    (write - write1h) * price.input * 1.25 +
    write1h * price.input * 2;
  return tokens / 1_000_000;
}

/**
 * Follows one transcript file and keeps running totals.
 *
 * A transcript is JSON lines, and Claude Code writes one line per content block of an
 * assistant message, each carrying that message's usage. So usage is kept per message id,
 * the latest line winning, and summed from there. Reads are incremental from the last
 * offset, so a long conversation is not re-parsed on every hook event.
 */
export class TranscriptUsage {
  private file: string | null = null;
  private offset = 0;
  private pending = '';
  private messages = new Map<string, Entry>();
  private lastModel: string | undefined;
  private reading: Promise<PaneUsage | undefined> | null = null;

  /** Point at a (possibly new) transcript. Switching files starts the totals over. */
  follow(file: string): void {
    if (file === this.file) return;
    this.file = file;
    this.reset();
  }

  clear(): void {
    this.file = null;
    this.reset();
  }

  private reset(): void {
    this.offset = 0;
    this.pending = '';
    this.messages.clear();
    this.lastModel = undefined;
  }

  /** Read whatever was appended since last time and return the totals, if there are any. */
  read(): Promise<PaneUsage | undefined> {
    // Overlapping reads would consume the same bytes twice.
    this.reading ??= this.readNew().finally(() => (this.reading = null));
    return this.reading;
  }

  private async readNew(): Promise<PaneUsage | undefined> {
    const file = this.file;
    if (!file) return undefined;
    const info = await stat(file).catch(() => null);
    if (!info) return this.totals();
    if (info.size < this.offset) this.reset();
    if (info.size > this.offset) {
      const handle = await open(file, 'r');
      try {
        const length = info.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = info.size;
        this.consume(buffer.toString('utf8'));
      } finally {
        await handle.close();
      }
    }
    return this.totals();
  }

  /** Exposed for tests: feed transcript text directly. */
  consume(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      // Cheap filter first: most lines are tool results and user turns.
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          uuid?: string;
          message?: { id?: string; model?: string; usage?: MessageUsage };
        };
        const msg = entry.message;
        if (entry.type !== 'assistant' || !msg?.usage) continue;
        const id = msg.id ?? entry.uuid;
        if (!id) continue;
        this.messages.set(id, { model: msg.model, usage: msg.usage });
        if (msg.model && msg.model !== '<synthetic>') this.lastModel = msg.model;
      } catch {
        /* a line still being written, or one that is not ours */
      }
    }
  }

  totals(): PaneUsage | undefined {
    if (!this.messages.size) return undefined;
    const t: PaneUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      model: this.lastModel,
    };
    for (const { model, usage: u } of this.messages.values()) {
      t.inputTokens += u.input_tokens ?? 0;
      t.outputTokens += u.output_tokens ?? 0;
      t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      t.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      const cost = messageCost(model, u);
      t.costUsd = cost === undefined || t.costUsd === undefined ? undefined : t.costUsd + cost;
    }
    return t;
  }
}
