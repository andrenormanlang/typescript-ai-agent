import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  GoogleGenerativeAI,
  type EmbedContentResponse,
} from "@google/generative-ai";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { MongoClient } from "mongodb";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Embeddings } from "@langchain/core/embeddings";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import "dotenv/config";

/**
 * Custom Embeddings class specifically for the model your key supports
 */
class GeminiEmbeddings extends Embeddings {
  private client: any;
  constructor(apiKey: string) {
    super({});
    // Hardcoded to the model we verified works for you
    this.client = new GoogleGenerativeAI(apiKey).getGenerativeModel(
      { model: "gemini-embedding-001" },
      { apiVersion: "v1beta" }
    );
  }
  async embedQuery(text: string): Promise<number[]> {
    const res = (await this.client.embedContent(
      text.replace(/\n/g, " "),
    )) as EmbedContentResponse;
    return res.embedding.values ?? [];
  }
  async embedDocuments(documents: string[]): Promise<number[][]> {
    const requests = documents.map((doc) => ({
      content: { role: "user", parts: [{ text: doc.replace(/\n/g, " ") }] },
    }));
    const res = await this.client.batchEmbedContents({ requests });
    return res.embeddings.map((e: any) => e.values || []);
  }
}

export async function callAgent(
  client: MongoClient,
  query: string,
  thread_id: string,
): Promise<string> {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("Missing GOOGLE_API_KEY.");
  }

  const db = client.db("fullstack_db");
  const collection = db.collection("principles");

  // Define State
  const GraphState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
    }),
  });

  // Setup LLM
  const geminiModelName = process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
  const model = new ChatGoogleGenerativeAI({
    model: geminiModelName,
    temperature: 0.1,
    apiKey: process.env.GOOGLE_API_KEY,
  });

  // LLM Node Logic
  async function callModel(state: typeof GraphState.State) {
    const lastHumanMessage = [...state.messages]
      .reverse()
      .find((m) => m instanceof HumanMessage || (m as any)._getType?.() === "human");

    const userQuery = lastHumanMessage?.content as string || "";

    // Setup Vector Store with the verified working model
    const vectorStore = new MongoDBAtlasVectorSearch(
      new GeminiEmbeddings(process.env.GOOGLE_API_KEY!),
      {
        collection,
        indexName: "vector_index",
        textKey: "embedding_text",
        embeddingKey: "embedding",
      }
    );

    // Perform Retrieval
    console.log(`🔍 Searching MongoDB for: "${userQuery}"`);
    const retrievedDocs = userQuery 
      ? await vectorStore.similaritySearch(userQuery, 3) 
      : [];
    
    const contextJson = JSON.stringify(retrievedDocs, null, 2);

    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are a specialized Fullstack Engineering assistant. 
        Use the following context to answer the user's question. 
        If you find the answer, prefix it with "FINAL ANSWER".

        CONTEXT:
        {context}`,
      ],
      new MessagesPlaceholder("messages"),
    ]);

    const formattedPrompt = await prompt.formatMessages({
      context: contextJson,
      messages: state.messages,
    });

    const result = await model.invoke(formattedPrompt);
    return { messages: [result] };
  }

  // Build Graph
  const workflow = new StateGraph(GraphState)
    .addNode("agent", callModel)
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__");

  const checkpointer = new MongoDBSaver({ client, dbName: "fullstack_db" });
  const app = workflow.compile({ checkpointer });

  // Execute
  const finalState = await app.invoke(
    { messages: [new HumanMessage(query)] },
    { configurable: { thread_id } }
  );

  return finalState.messages[finalState.messages.length - 1].content as string;
}