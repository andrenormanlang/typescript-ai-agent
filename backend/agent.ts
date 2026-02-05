import { ChatAnthropic } from "@langchain/anthropic";
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
 * This agent uses Anthropic (ChatAnthropic) with LangGraph's StateGraph
 * to query the "frontend_db.principles" collection in MongoDB.
 * It leverages a "principle_lookup" tool that uses MongoDBAtlasVectorSearch.
 */
export async function callAgent(
  client: MongoClient,
  query: string,
  thread_id: string,
): Promise<string> {
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

  // 5. Create an Anthropic model and bind the tools to it
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-5-20250929", // or "claude-1.3" / "claude-2.0" / "claude-instant" etc.
    temperature: 0.1,
    // Workaround: @langchain/anthropic defaults topP to -1 (sent as top_p=-1),
    // and this model rejects top_p=-1. Also, this model disallows specifying
    // both temperature and top_p. So we *omit* top_p entirely.
    invocationKwargs: { top_p: undefined },
  }).bindTools(tools);

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

    // Call the Anthropic model
    const result = await model.invoke(formattedPrompt);

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
