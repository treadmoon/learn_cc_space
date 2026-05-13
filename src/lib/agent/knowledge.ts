import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from './tools';
import OpenAI from 'openai';

const WORKDIR = process.cwd();
const KNOWLEDGE_DIR = path.join(WORKDIR, '.knowledge');
const DOCS_FILE = path.join(KNOWLEDGE_DIR, 'docs.json');
const DB_DIR = path.join(KNOWLEDGE_DIR, 'db');
const CHUNK_MAX = 500;
const CHUNK_OVERLAP = 50;

/* ── Types ── */
interface KnowledgeDoc {
    source: string;
    chunkCount: number;
    ingestedAt: string;
}

interface ChunkRecord {
    id: string;
    source: string;
    content: string;
    chunkIndex: number;
    embedding: number[];
    createdAt: string;
}

/* ── Text chunking ── */
function chunkText(text: string, maxLen = CHUNK_MAX, overlap = CHUNK_OVERLAP): string[] {
    // Normalize line endings
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split by double newline (paragraphs)
    const paragraphs = normalized.split(/\n\n+/);
    const chunks: string[] = [];
    let buffer = '';

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        // If adding this paragraph exceeds max, flush buffer
        if (buffer && (buffer.length + trimmed.length + 2) > maxLen) {
            chunks.push(buffer.trim());
            // Keep overlap from end of buffer
            buffer = buffer.length > overlap
                ? buffer.slice(-overlap) + '\n\n' + trimmed
                : trimmed;
        } else {
            buffer = buffer ? buffer + '\n\n' + trimmed : trimmed;
        }

        // If single paragraph exceeds max, split by sentences
        if (buffer.length > maxLen) {
            const sentences = buffer.split(/(?<=[.!?。！？\n])\s*/);
            buffer = '';
            let sentenceBuf = '';
            for (const sent of sentences) {
                if (sentenceBuf && (sentenceBuf.length + sent.length) > maxLen) {
                    chunks.push(sentenceBuf.trim());
                    sentenceBuf = sentenceBuf.length > overlap
                        ? sentenceBuf.slice(-overlap) + ' ' + sent
                        : sent;
                } else {
                    sentenceBuf = sentenceBuf ? sentenceBuf + ' ' + sent : sent;
                }
            }
            buffer = sentenceBuf;
        }
    }

    if (buffer.trim()) {
        chunks.push(buffer.trim());
    }

    return chunks.filter(c => c.length > 0);
}

/* ── BM25 scoring (lightweight, no deps) ── */
function tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(t => t.length > 1);
}

function bm25Score(query: string, documents: string[], k1 = 1.5, b = 0.75): number[] {
    const queryTokens = tokenize(query);
    const docTokens = documents.map(d => tokenize(d));
    const avgDl = docTokens.reduce((s, t) => s + t.length, 0) / (docTokens.length || 1);
    const N = documents.length;

    // Document frequency
    const df: Record<string, number> = {};
    for (const tokens of docTokens) {
        const seen = new Set(tokens);
        for (const t of seen) df[t] = (df[t] || 0) + 1;
    }

    return docTokens.map(tokens => {
        const tf: Record<string, number> = {};
        for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
        const dl = tokens.length;
        let score = 0;
        for (const qt of queryTokens) {
            const termFreq = tf[qt] || 0;
            const docFreq = df[qt] || 0;
            if (termFreq === 0) continue;
            const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
            const tfNorm = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * dl / avgDl));
            score += idf * tfNorm;
        }
        return score;
    });
}

/* ── Cosine similarity ── */
function cosineSim(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

/* ── KnowledgeManager ── */
export class KnowledgeManager {
    private docs: Record<string, KnowledgeDoc> = {};
    private chunks: ChunkRecord[] = [];
    private client: OpenAI;
    private embeddingModel: string;
    private initialized = false;

    constructor() {
        mkdirSync(KNOWLEDGE_DIR);
        mkdirSync(DB_DIR);
        this._loadDocs();
        this._loadChunks();

        this.client = new OpenAI({
            baseURL: process.env.EMBEDDING_BASE_URL || process.env.ANTHROPIC_BASE_URL,
            apiKey: process.env.ANTHROPIC_API_KEY || 'sk-none',
        });
        this.embeddingModel = process.env.EMBEDDING_MODEL_ID || 'text-embedding-v3';
    }

    private _loadDocs() {
        try {
            if (fs.existsSync(DOCS_FILE)) {
                this.docs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
            }
        } catch { this.docs = {}; }
    }

    private _saveDocs() {
        fs.writeFileSync(DOCS_FILE, JSON.stringify(this.docs, null, 2), 'utf8');
    }

    private _loadChunks() {
        try {
            const chunksFile = path.join(DB_DIR, 'chunks.json');
            if (fs.existsSync(chunksFile)) {
                this.chunks = JSON.parse(fs.readFileSync(chunksFile, 'utf8'));
            }
        } catch { this.chunks = []; }
    }

    private _saveChunks() {
        const chunksFile = path.join(DB_DIR, 'chunks.json');
        fs.writeFileSync(chunksFile, JSON.stringify(this.chunks), 'utf8');
    }

    private async _embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const response = await this.client.embeddings.create({
            model: this.embeddingModel,
            input: texts,
        });
        return response.data.map(d => d.embedding);
    }

    private _readFile(filePath: string): string {
        const resolved = path.resolve(WORKDIR, filePath);
        if (!resolved.startsWith(WORKDIR)) throw new Error('Path outside workspace');
        if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`);
        return fs.readFileSync(resolved, 'utf8');
    }

    /* ── Public API ── */

    async ingest(filePath: string): Promise<string> {
        const content = this._readFile(filePath);
        const source = path.relative(WORKDIR, path.resolve(WORKDIR, filePath));
        return this._doIngest(content, source);
    }

    async ingestText(text: string, source: string): Promise<string> {
        if (!text.trim()) return 'Error: Empty text';
        if (!source.trim()) return 'Error: Source identifier required';
        return this._doIngest(text, source);
    }

    private async _doIngest(content: string, source: string): Promise<string> {
        // Check if already exists
        if (this.docs[source]) {
            // Remove old chunks
            this.chunks = this.chunks.filter(c => c.source !== source);
        }

        // Chunk
        const textChunks = chunkText(content);
        if (textChunks.length === 0) return `Error: No content to ingest from ${source}`;

        // Embed
        let embeddings: number[][];
        try {
            embeddings = await this._embed(textChunks);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Error embedding text: ${msg}`;
        }

        // Store
        const now = new Date().toISOString();
        const records: ChunkRecord[] = textChunks.map((text, i) => ({
            id: randomUUID().slice(0, 8),
            source,
            content: text,
            chunkIndex: i,
            embedding: embeddings[i],
            createdAt: now,
        }));

        this.chunks.push(...records);
        this.docs[source] = { source, chunkCount: textChunks.length, ingestedAt: now };

        this._saveChunks();
        this._saveDocs();

        return `Ingested ${source}: ${textChunks.length} chunks, ${content.length} chars total.`;
    }

    async search(query: string, topK = 5): Promise<string> {
        if (this.chunks.length === 0) return 'Knowledge base is empty. Use knowledge_ingest to add documents first.';

        let queryEmbedding: number[];
        try {
            const embeddings = await this._embed([query]);
            queryEmbedding = embeddings[0];
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Error embedding query: ${msg}`;
        }

        // Vector scores
        const vectorScores = this.chunks.map(c => cosineSim(queryEmbedding, c.embedding));

        // BM25 scores
        const contents = this.chunks.map(c => c.content);
        const bm25Scores = bm25Score(query, contents);

        // Normalize scores to [0, 1]
        const maxVec = Math.max(...vectorScores, 0.001);
        const maxBm25 = Math.max(...bm25Scores, 0.001);
        const combined = vectorScores.map((vs, i) => ({
            idx: i,
            score: 0.7 * (vs / maxVec) + 0.3 * (bm25Scores[i] / maxBm25),
        }));

        // Sort by combined score, take topK
        combined.sort((a, b) => b.score - a.score);
        const top = combined.slice(0, topK);

        if (top.length === 0 || top[0].score < 0.01) {
            return 'No relevant results found in knowledge base.';
        }

        // Format results
        const lines = top.map((r, i) => {
            const chunk = this.chunks[r.idx];
            return [
                `[Result ${i + 1}] (score: ${r.score.toFixed(3)}) source: ${chunk.source}#${chunk.chunkIndex}`,
                chunk.content,
            ].join('\n');
        });

        return `Found ${top.length} relevant chunks:\n\n${lines.join('\n\n---\n\n')}`;
    }

    list(): string {
        const entries = Object.values(this.docs);
        if (entries.length === 0) return 'Knowledge base is empty.';
        const lines = entries.map(d => `  - ${d.source}: ${d.chunkCount} chunks (ingested: ${d.ingestedAt})`);
        return `Knowledge base (${entries.length} documents, ${this.chunks.length} chunks):\n${lines.join('\n')}`;
    }

    remove(source: string): string {
        if (!this.docs[source]) return `Document not found: ${source}`;
        const chunkCount = this.docs[source].chunkCount;
        delete this.docs[source];
        this.chunks = this.chunks.filter(c => c.source !== source);
        this._saveDocs();
        this._saveChunks();
        return `Removed ${source} (${chunkCount} chunks).`;
    }

    getStats(): { docCount: number; chunkCount: number; sources: Array<{ source: string; chunkCount: number; ingestedAt: string }> } {
        return {
            docCount: Object.keys(this.docs).length,
            chunkCount: this.chunks.length,
            sources: Object.values(this.docs),
        };
    }
}
