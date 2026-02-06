import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { MongoClient } from "mongodb";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { StateGraph } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { z } from "zod";
import "dotenv/config";

/**
 * This agent uses Gemini (ChatGoogleGenerativeAI) with LangGraph's StateGraph
 * to query the "frontend_db.principles" collection in MongoDB.
 * It leverages a "principle_lookup" tool that uses MongoDBAtlasVectorSearch.
 */
export async function callAgent(
  client: MongoClient,
  query: string,
  thread_id: string,
): Promise<string> {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
      "Missing GOOGLE_API_KEY. Set it in backend/.env (this file is gitignored).",
    );
  }

  // 1. Connect to the "frontend_db" and the "principles" collection
  const db = client.db("frontend_db");
  const collection = db.collection("principles");

  // 2. Define a StateGraph with a root annotation (messages)
  //    We'll store the conversation history here.
  const GraphState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
    }),
  });

  // 3. Create a "principle lookup" tool to fetch vector-based search results
  const principleLookupTool = tool(
    async ({ query, n = 3 }) => {
      console.log("Principle lookup tool called.");

      // Set up the vector store using the "principles" collection
      const dbConfig = {
        collection,
        indexName: "vector_index", // Must match how you seeded the collection
        textKey: "embedding_text", // Must match how you seeded the collection
        embeddingKey: "embedding", // Must match how you seeded the collection
      };

      // Create the vector store
      const vectorStore = new MongoDBAtlasVectorSearch(
        new OpenAIEmbeddings(), // Using OpenAI embeddings
        dbConfig,
      );

      // Perform a similarity search
      const result = await vectorStore.similaritySearchWithScore(query, n);
      return JSON.stringify(result, null, 2);
    },
    {
      name: "principle_lookup",
      description:
        "Searches the 'frontend_db.principles' collection for relevant frontend principles.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "The search query (e.g., a question about frontend design).",
          ),
        n: z
          .number()
          .optional()
          .default(3)
          .describe("Number of results to return from the search."),
      }),
    },
  );

  // Gather all the tools in an array
  const tools = [principleLookupTool];

  // 4. Create a ToolNode so the agent can call these tools
  const toolNode = new ToolNode<typeof GraphState.State>(tools);

  // 5. Create a Gemini model and bind the tools to it
  const geminiModelName =
    process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";

  const modelWithTools = new ChatGoogleGenerativeAI({
    model: geminiModelName,
    temperature: 0.1,
    apiKey: process.env.GOOGLE_API_KEY,
  }).bindTools(tools);

  // After we have tool output, force synthesis by disabling tools.
  const modelNoTools = new ChatGoogleGenerativeAI({
    model: geminiModelName,
    temperature: 0.1,
    apiKey: process.env.GOOGLE_API_KEY,
  });

  // 6. Define a function to decide the next node: either go to tools or end
  function shouldContinue(state: typeof GraphState.State) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;
    // If the LLM wants to call a tool, go to the "tools" node
    if (lastMessage.tool_calls?.length) {
      return "tools";
    }
    // Otherwise, we end the chain
    return "__end__";
  }

  // 7. Define the function that calls the LLM with a prompt
  async function callModel(state: typeof GraphState.State) {
    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are a helpful AI assistant, specialized in frontend design principles.
Use the provided tools if needed to answer the user's query.
If you or any other assistant have the final answer, prefix your response with "FINAL ANSWER" so the team knows to stop.
You have access to the following tools: {tool_names}.
{system_message}
Current time: {time}.`,
      ],
      // This placeholder will be replaced by the conversation messages
      new MessagesPlaceholder("messages"),
    ]);

    // Format the prompt with dynamic data
    const formattedPrompt = await prompt.formatMessages({
      system_message: "You are a helpful Frontend Chatbot Agent.",
      time: new Date().toISOString(),
      tool_names: tools.map((t) => t.name).join(", "),
      messages: state.messages,
    });

    const hasToolResult = state.messages.some(
      (m) => (m as { _getType?: () => string })._getType?.() === "tool",
    );

    // Call the Gemini model
    const result = await (hasToolResult ? modelNoTools : modelWithTools).invoke(
      formattedPrompt,
    );

    // Gemini 3 tool calling requires "thought signatures" to be preserved across
    // tool-use turns. Some SDK layers (and older LangChain integrations) may drop
    // these fields, which causes 400s on the follow-up request.
    //
    // The Gemini docs allow using the dummy signature "skip_thought_signature_validator"
    // when a signature is unavailable.
    const maybeToolCalls = (result as AIMessage).tool_calls;
    if (maybeToolCalls?.length) {
      const first = maybeToolCalls[0] as unknown as {
        extra_content?: { google?: { thought_signature?: string } };
      };
      first.extra_content ??= {};
      first.extra_content.google ??= {};
      first.extra_content.google.thought_signature ??=
        "skip_thought_signature_validator";
    }

    // Return the new AI message so it gets appended to state
    return { messages: [result] };
  }

  // 8. Build the state graph
  const workflow = new StateGraph(GraphState)
    .addNode("agent", callModel) // The node that calls the LLM
    .addNode("tools", toolNode) // The node that executes tool calls
    .addEdge("__start__", "agent") // Start by calling the LLM
    .addConditionalEdges("agent", shouldContinue) // Decide whether to go to tools or end
    .addEdge("tools", "agent"); // After using tools, go back to the LLM

  // 9. Use a MongoDBSaver to persist the conversation state (thread-based memory)
  const checkpointer = new MongoDBSaver({
    client,
    dbName: "frontend_db",
  });

  // 10. Compile the workflow into a Runnable
  const app = workflow.compile({ checkpointer });

  // 11. Invoke the app with the user's query as a new conversation
  const finalState = await app.invoke(
    {
      messages: [new HumanMessage(query)],
    },
    { recursionLimit: 15, configurable: { thread_id } },
  );

  // 12. Log or return the final AI message
  const lastMessage =
    finalState.messages[finalState.messages.length - 1].content;
  console.log("Agent final message:", lastMessage);

  return lastMessage as string;
}
