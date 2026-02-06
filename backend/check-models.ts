import "dotenv/config";

const API_KEY = process.env.GOOGLE_API_KEY;
const URL = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

async function checkModels() {
  console.log("🔍 Querying Google for available models...");
  try {
    const response = await fetch(URL);
    const data = await response.json();

    if (data.error) {
      console.error("❌ API Error:", data.error);
      return;
    }

    const models = data.models || [];
    const embeddingModels = models.filter((m: any) => 
      m.name.includes("embed") || m.supportedGenerationMethods?.includes("embedContent")
    );

    console.log("\n✅ AVAILABLE EMBEDDING MODELS:");
    if (embeddingModels.length === 0) {
      console.log("   (None found. Your API Key might lack permissions)");
    } else {
      embeddingModels.forEach((m: any) => {
        console.log(`   - ${m.name}`); // e.g., models/text-embedding-004
      });
    }

    console.log("\n📋 ALL MODELS:");
    console.log(models.map((m: any) => m.name).join(", "));

  } catch (error) {
    console.error("Network error:", error);
  }
}

checkModels();