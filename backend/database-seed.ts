import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  GoogleGenerativeAI,
  type EmbedContentResponse,
} from "@google/generative-ai";
import { MongoClient } from "mongodb";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { Embeddings } from "@langchain/core/embeddings";
import "dotenv/config";

// --- Configuration ---
const DB_NAME = "fullstack_db";
const COLLECTION_NAME = "principles";
const INDEX_NAME = "vector_index";

// 1. Validate Environment
if (!process.env.GOOGLE_API_KEY) {
  throw new Error("Missing GOOGLE_API_KEY. Set it in backend/.env");
}
if (!process.env.MONGODB_ATLAS_URI) {
  throw new Error("Missing MONGODB_ATLAS_URI. Set it in backend/.env");
}

const client = new MongoClient(process.env.MONGODB_ATLAS_URI);

// 2. Setup LLM (Using your available Gemini 3 Flash Preview)
const geminiModelName = process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
const llm = new ChatGoogleGenerativeAI({
  model: geminiModelName,
  temperature: 0.7,
  apiKey: process.env.GOOGLE_API_KEY,
});

// --- Custom Embeddings Class ---
class GeminiEmbeddings extends Embeddings {
  private modelName: string;
  private apiKey: string;
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(fields: { apiKey: string; modelName: string }) {
    super({});
    this.apiKey = fields.apiKey;
    // Strip "models/" prefix if present
    this.modelName = fields.modelName.replace(/^models\//, "");
    
    this.genAI = new GoogleGenerativeAI(this.apiKey);
    
    // We use v1beta because your check-models.ts found the model there
    this.model = this.genAI.getGenerativeModel(
      { model: this.modelName },
      { apiVersion: "v1beta" }
    );
  }

  async embedQuery(text: string): Promise<number[]> {
    // Gemini embeddings dislike newlines
    const cleaned = text.replace(/\n/g, " ");
    try {
      const res = (await this.model.embedContent(cleaned)) as EmbedContentResponse;
      return res.embedding.values ?? [];
    } catch (e: any) {
      console.error(`\n❌ Error embedding query with model '${this.modelName}':`);
      console.error(`   Details: ${e.message}`);
      throw e;
    }
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    const requests = documents.map((doc) => ({
      content: { role: "user", parts: [{ text: doc.replace(/\n/g, " ") }] },
    }));
    try {
      const res = await this.model.batchEmbedContents({ requests });
      return res.embeddings.map((e: any) => e.values || []);
    } catch (e: any) {
      console.error(`\n❌ Error embedding batch documents with model '${this.modelName}':`);
      console.error(`   Details: ${e.message}`);
      throw e;
    }
  }
}

// 3. Instantiate Embeddings with your SPECIFIC model
// We found "models/gemini-embedding-001" in your list.
const embeddings = new GeminiEmbeddings({
  apiKey: process.env.GOOGLE_API_KEY,
  modelName: "gemini-embedding-001", 
});

// --- Helper Types & Functions ---

export type FullstackPrinciple = {
  principle_id: string;
  name: string;
  description: string;
  keyConcepts: string[];
  designGuidelines: string[];
  commonPitfalls: string[];
  bestPractices: string[];
  relevantTechnologies: string[];
  notes: string;
};

function parseJsonArrayFromModel(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON array.");
  }
}

async function generateSyntheticData(): Promise<FullstackPrinciple[]> {
  const prompt = `Generate 10 fictional records of fullstack principles (frontend, backend, db, security).
Return ONLY valid JSON array. Each object must have keys:
principle_id, name, description, keyConcepts, designGuidelines, commonPitfalls, bestPractices, relevantTechnologies, notes`;

  console.log("🤖 Generating synthetic data with Gemini...");
  const response = await llm.invoke(prompt);
  const raw = parseJsonArrayFromModel(response.content as string);
  return raw as FullstackPrinciple[];
}

async function createPrincipleSummary(principle: FullstackPrinciple): Promise<string> {
  return `${principle.name}: ${principle.description}. Key Concepts: ${principle.keyConcepts.join(", ")}.`;
}

// --- Main Seed Function ---

async function seedDatabase() {
  try {
    // 1. Connect
    console.log("🔌 Connecting to MongoDB...");
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB.");

    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    // 2. Sanity Check Embeddings
    console.log(`🧪 Testing Embeddings API with model 'gemini-embedding-001'...`);
    const sampleVector = await embeddings.embedQuery("Hello World");
    console.log(`✅ Embeddings working! Dimension: ${sampleVector.length}`);

    // 3. Generate Data
    const principles = await generateSyntheticData();
    console.log(`📦 Generated ${principles.length} principles.`);

    // 4. Prepare Documents
    const docs = await Promise.all(
      principles.map(async (p) => ({
        pageContent: await createPrincipleSummary(p),
        metadata: p,
      }))
    );

    // 5. Save to Vector Store
    console.log(`💾 Saving to ${DB_NAME}.${COLLECTION_NAME}...`);
    
    // Clear old data first
    await collection.deleteMany({});

    await MongoDBAtlasVectorSearch.fromDocuments(docs, embeddings, {
      collection,
      indexName: INDEX_NAME,
      textKey: "embedding_text",
      embeddingKey: "embedding",
    });

    console.log("🚀 Database seeding completed successfully!");

  } catch (error) {
    console.error("\n💥 FATAL ERROR SEEDING DATABASE 💥");
    console.error(error);
  } finally {
    await client.close();
  }
}

seedDatabase();