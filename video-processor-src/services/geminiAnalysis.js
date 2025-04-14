const { GoogleGenerativeAI } = require("@google/generative-ai");

class GeminiAnalysisService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
  }

  async analyzeResults(results) {
    try {
      const prompt = this.constructPrompt(results);
      const response = await this.model.generateContent(prompt);
      const analysis = response.response.text();

      console.log(`[${new Date().toISOString()}] 🤖 Gemini Analysis completed`);
      return analysis;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error in Gemini analysis:`,
        error.message
      );
      throw error;
    }
  }

  constructPrompt(results) {
    const { transcription, objects, labels, text } = results;

    return `Please analyze this property video and provide a comprehensive summary. Here are the details:

TRANSCRIPTION:
${transcription}

DETECTED OBJECTS:
${objects
  .map(
    (obj) =>
      `- ${obj.description} (Confidence: ${(obj.confidence * 100).toFixed(1)}%)`
  )
  .join("\n")}

DETECTED LABELS:
${labels
  .map(
    (label) =>
      `- ${label.description} (Confidence: ${(label.confidence * 100).toFixed(
        1
      )}%)`
  )
  .join("\n")}

DETECTED TEXT:
${text
  .map((t) => `- "${t.text}" (Confidence: ${(t.confidence * 100).toFixed(1)}%)`)
  .join("\n")}

Please provide:
1. A summary of the property's key features and characteristics
2. Notable items and fixtures present
3. Any price information or property details mentioned
4. Overall condition assessment
5. Any unique or standout features

Format the response in a clear, structured manner with appropriate sections and bullet points where relevant.`;
  }
}

module.exports = new GeminiAnalysisService();
