# JS AI Agent using LangGraph and MongoDB 🚀🤖

This project showcases how to integrate LangGraph with MongoDB for building and managing AI agents and conversational applications. I created this project to explore the integration of language models, graph-based conversation management, and MongoDB for data persistence, enabling the creation of intelligent, autonomous agents using TypeScript and Express.js.💡💻

## Features ✨

- **LangGraph Integration:** Manages agentic conversational flows in TypeScript. 🔄
- **MongoDB Atlas:** Stores and retrieves conversation data.☁️🗄️
- **RESTful API:** Built with Express.js for handling chat interactions.🌐
- **AI Integration:** Utilises Google's Gemini for generating responses and embeddings.🤖🧠
- **Fullstack Principles Lookup**: Implements MongoDB Atlas vector search for retrieving and discussing fullstack engineering principles. 🔍🧱

## Prerequisites

- [Node.js](https://nodejs.org/) and npm
- A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) account
- Google AI (Gemini) API key

## Installation 🛠️

1. **Clone this repository:**

   ```bash
   git clone https://github.com/andrenormanlang/javascript-ai-agent
   cd javascript-ai-agent
   ```

2. **Install dependencies:**

   ```bash
    npm install
    ```

3. **Set environment variables:**

    Create a `.env` file in the root directory and add the following:

    ```bash
    GOOGLE_API_KEY=your_gemini_api_key_here
    MONGODB_ATLAS_URI=your_mongodb_atlas_uri_here
    ```

    Optional:

    ```bash
    GEMINI_MODEL=gemini-3-flash-preview
    GEMINI_EMBEDDING_MODEL=embedding-001
    ```

4. **Seeding the Database:**

    ```bash
  cd backend
  npx ts-node database-seed.ts
    ```

5. **Atlas Vector Search Indexing:**

  Go to your MongoDB Atlas dashboard and create a new vector search index for the `fullstack_db.principles` collection as a JSON editor.

    Index Name: vector_index

    Index Definition:

    ```json
    {
      "fields": [
        {
          "numDimensions": 768,
          "path": "embedding",
          "similarity": "cosine",
          "type": "vector"
        }
      ]
    }
    ```

    This index will be used for retrieving fullstack principles based on their embeddings.

    Note: if you change `GEMINI_EMBEDDING_MODEL`, the embedding dimension may change.
    The seed script logs the actual embedding length it gets from Gemini—match `numDimensions` to that value.

## Usage ▶️

1. **Start the server:**

    ```bash
    npx ts-node index.ts
    ```

2. **API Endpoints:**

### Start a new conversation 💬

```bash
curl -X POST -H "Content-Type: application/json" -d '{"message": "Your message here"}' http://localhost:3000/chat
```

- Curl example:

```bash
curl -X POST   -H "Content-Type: application/json"   -d '{

    "message": "How can I make a responsive layout that is also accessible for people with disabilities?"
  }'   http://localhost:3000/chat
```

### Continue an existing conversation 🔄

```bash
curl -X POST -H "Content-Type: application/json" -d '{"message": "Your follow-up message"}' http://localhost:3000/chat/{threadId}
```

- Curl example:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Can you tell me what are some common pitfalls when implementing these practices?",
    "thread_id": "1739739439130"
  }' \
  http://localhost:3000/chat/1739739439130
```

## Project Structure 📁

- backend/index.ts: Entry point for the Express.js server and API routes.
- backend/agent.ts: Defines the LangGraph agent, its tools and the conversation flow.
- backend/database-seed.ts: Script for seeding MongoDB Atlas with synthetic fullstack principles + embeddings.

## How it Works ⚙️

- **Data Seeding**: The backend/database-seed.ts script generates synthetic fullstack principles and populates MongoDB with embeddings for Atlas Vector Search. 🌱
- **LangGraph Agent**: Defined in agent.ts, it manages the conversation graph structure and integrates the necessary tools. 🔧
- **Database Integration**: MongoDB operations are directly integrated into the agent for storing and retrieving conversation data. 💾
- **API Endpoints**: The Express server in index.ts provides endpoints for starting and continuing conversations. 📡
- **State Persistence**: Conversation data is persisted in MongoDB Atlas, ensuring continuity across sessions. 🔒