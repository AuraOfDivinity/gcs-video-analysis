const express = require("express");
const { Storage } = require("@google-cloud/storage");
const videoIntelligence = require("@google-cloud/video-intelligence");
const OpenAI = require("openai");
const firestoreService = require("./services/firestoreService");
const { google } = require("googleapis");

// Initialize Google Drive client
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});
const drive = google.drive({ version: "v3", auth });

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(express.json());

// Track processed files to prevent reprocessing
const processedFiles = new Set();
const failedFiles = new Set(); // Track files that have failed processing
const processedMessageIds = new Set(); // Track processed Pub/Sub message IDs
const MAX_QUEUE_SIZE = 10; // Maximum number of items in the queue

// Queue for processing videos
const processingQueue = [];
let isProcessing = false;

const MAX_LABELS_PER_SEGMENT = 5;
const CONFIDENCE_THRESHOLD = 0.7;
const FRAME_INTERVAL_SECONDS = 1;

const PROPERTY_ANALYSIS_FOLDER_ID = "1jPqOFqS_RisO97QAaOoMHgQtiYQOBgwa";

// Middleware to parse Pub/Sub messages
app.use((req, res, next) => {
  if (req.body.message && req.body.message.data) {
    try {
      // Store the message ID for deduplication
      const messageId = req.body.message.messageId;
      console.log(
        `[${new Date().toISOString()}] 📨 Received Pub/Sub message ID: ${messageId}`
      );

      // Check if this message has already been processed
      if (processedMessageIds.has(messageId)) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Message ID ${messageId} already processed, skipping`
        );
        return res.status(200).json({
          message: "Message already processed",
          messageId: messageId,
        });
      }

      // Pub/Sub messages are base64 encoded
      const decodedData = Buffer.from(
        req.body.message.data,
        "base64"
      ).toString();
      req.body = JSON.parse(decodedData);
      console.log(
        `[${new Date().toISOString()}] 📦 Processing file: ${
          req.body.name
        } (Message ID: ${messageId})`
      );

      // Store the message ID in the request for later use
      req.messageId = messageId;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error parsing Pub/Sub message:`,
        error
      );
      return res.status(400).json({
        error: "Invalid Pub/Sub message format",
        details: error.message,
      });
    }
  }
  next();
});

const storage = new Storage();
const videoClient = new videoIntelligence.VideoIntelligenceServiceClient();

// Function to filter and optimize video analysis data
function optimizeVideoData(trackedObjects, detectedLabels, detectedText) {
  // Ensure inputs are arrays and have the expected structure
  const objects = Array.isArray(trackedObjects) ? trackedObjects : [];
  const labels = Array.isArray(detectedLabels) ? detectedLabels : [];
  const text = Array.isArray(detectedText) ? detectedText : [];

  console.log(
    `[${new Date().toISOString()}] 🔍 Processing video data:`,
    `Objects: ${objects.length}, Labels: ${labels.length}, Text: ${text.length}`
  );

  // Process object tracking data with minimal filtering
  const processedObjects = objects.reduce((acc, obj) => {
    if (!obj || typeof obj !== "object") return acc;

    const key = (obj.description || "").toLowerCase();
    if (!key) return acc;

    if (!acc[key]) {
      acc[key] = {
        count: 0,
        confidence: 0,
        occurrences: [],
        timestamps: [],
        firstSeen: obj.timestamp,
        lastSeen: obj.timestamp,
        averageConfidence: 0,
        maxConfidence: obj.confidence || 0,
        minConfidence: obj.confidence || 0,
        duration: 0,
        frequency: 0,
        context: [],
      };
    }

    // Store all occurrences
    acc[key].occurrences.push({
      timestamp: obj.timestamp,
      confidence: obj.confidence || 0,
    });

    acc[key].count++;
    acc[key].confidence += obj.confidence || 0;
    acc[key].timestamps.push(obj.timestamp);
    acc[key].lastSeen = obj.timestamp;
    acc[key].maxConfidence = Math.max(
      acc[key].maxConfidence,
      obj.confidence || 0
    );
    acc[key].minConfidence = Math.min(
      acc[key].minConfidence,
      obj.confidence || 0
    );

    return acc;
  }, {});

  // Calculate statistics for each object
  Object.keys(processedObjects).forEach((key) => {
    if (processedObjects[key].count > 0) {
      processedObjects[key].averageConfidence =
        processedObjects[key].confidence / processedObjects[key].count;

      // Sort timestamps for better analysis
      processedObjects[key].timestamps.sort((a, b) => a - b);

      // Calculate time span
      processedObjects[key].timeSpan =
        processedObjects[key].lastSeen - processedObjects[key].firstSeen;

      // Calculate frequency (occurrences per second)
      processedObjects[key].frequency =
        processedObjects[key].count / (processedObjects[key].timeSpan || 1);

      // Add context based on frequency and duration
      if (processedObjects[key].frequency > 0.5) {
        processedObjects[key].context.push("Frequently visible");
      }
      if (processedObjects[key].timeSpan > 10) {
        processedObjects[key].context.push("Long duration presence");
      }
      if (processedObjects[key].averageConfidence > 0.7) {
        processedObjects[key].context.push("High confidence detection");
      }
    }
  });

  // Process label detection data with minimal filtering
  const processedLabels = labels.map((label) => ({
    description: label.description || "",
    confidence: label.confidence || 0,
    timestamp: label.timestamp || 0,
    context: {
      segment: Math.floor((label.timestamp || 0) / 2),
      timeRange: [
        Math.floor((label.timestamp || 0) / 2) * 2,
        (Math.floor((label.timestamp || 0) / 2) + 1) * 2,
      ],
      duration: 2,
      frequency: 1,
    },
  }));

  // Process text detection data with minimal filtering
  const processedText = text.map((text) => ({
    text: text.text || "",
    confidence: text.confidence || 0,
    timestamp: text.timestamp || 0,
    originalText: text.text || "",
    context: {
      confidence: text.confidence || 0,
      timestamp: text.timestamp || 0,
      duration: 1,
      frequency: 1,
    },
  }));

  // Group text by proximity to combine related information
  const groupedText = processedText.reduce((acc, text) => {
    const timeWindow = 5; // 5 seconds window
    const key = Math.floor(text.timestamp / timeWindow);

    if (!acc[key]) {
      acc[key] = [];
    }

    acc[key].push(text);
    return acc;
  }, {});

  // Combine text within each time window
  const combinedText = Object.values(groupedText).map((texts) => {
    const combined = texts.reduce(
      (acc, text) => {
        acc.text += " " + text.text;
        acc.confidence = Math.max(acc.confidence, text.confidence);
        acc.timestamps.push(text.timestamp);
        return acc;
      },
      {
        text: "",
        confidence: 0,
        timestamps: [],
      }
    );

    return {
      text: combined.text.trim(),
      confidence: combined.confidence,
      timestamp: Math.min(...combined.timestamps),
      originalTexts: texts,
      context: {
        duration:
          Math.max(...combined.timestamps) - Math.min(...combined.timestamps),
        frequency: texts.length,
        timeRange: [
          Math.min(...combined.timestamps),
          Math.max(...combined.timestamps),
        ],
      },
    };
  });

  console.log(
    `[${new Date().toISOString()}] ✅ Processed data:`,
    `Objects: ${Object.keys(processedObjects).length}, Labels: ${
      processedLabels.length
    }, Text: ${combinedText.length}`
  );

  return {
    objects: processedObjects,
    labels: processedLabels,
    text: combinedText,
    metadata: {
      originalObjectCount: objects.length,
      originalLabelCount: labels.length,
      originalTextCount: text.length,
      processingStats: {
        objectRetentionRate:
          (Object.keys(processedObjects).length / objects.length) * 100,
        labelRetentionRate: (processedLabels.length / labels.length) * 100,
        textRetentionRate: (combinedText.length / text.length) * 100,
      },
    },
  };
}

// Function to repair malformed JSON
function repairJson(text) {
  try {
    // First try to parse as is
    JSON.parse(text);
    return text;
  } catch (error) {
    console.log(
      `[${new Date().toISOString()}] 🔧 Attempting to repair malformed JSON...`
    );

    // Remove any non-JSON text before and after the JSON object
    let repaired = text.trim();

    // Find the first { and last }
    const firstBrace = repaired.indexOf("{");
    const lastBrace = repaired.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("No valid JSON object found");
    }

    repaired = repaired.substring(firstBrace, lastBrace + 1);

    // Fix common JSON issues
    repaired = repaired
      // Fix missing quotes around property names
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3')
      // Fix missing quotes around string values
      .replace(/(:\s*)([a-zA-Z0-9_]+)(\s*[,}])/g, '$1"$2"$3')
      // Fix missing commas between properties
      .replace(/}\s*{/g, "},{")
      // Fix missing commas in arrays
      .replace(/]\s*\[/g, "],[")
      // Fix missing quotes in arrays
      .replace(/\[\s*([a-zA-Z0-9_]+)\s*\]/g, '["$1"]')
      // Fix missing quotes around confidence scores
      .replace(/"confidence":\s*(\d+)/g, '"confidence":"$1"')
      // Remove any trailing commas
      .replace(/,(\s*[}\]])/g, "$1")
      // Fix any remaining unquoted strings
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3')
      // Fix any remaining unquoted values
      .replace(/(:\s*)([a-zA-Z0-9_]+)(\s*[,}])/g, '$1"$2"$3');

    try {
      // Try to parse the repaired JSON
      JSON.parse(repaired);
      return repaired;
    } catch (repairError) {
      console.error(
        `[${new Date().toISOString()}] ❌ Failed to repair JSON:`,
        repairError
      );
      throw new Error(`Failed to repair JSON: ${repairError.message}`);
    }
  }
}

// Function to clean and optimize data for API calls
function cleanDataForAPI(data, type) {
  switch (type) {
    case "labels":
      return data.map((label) => ({
        description: label.description,
        confidence: label.confidence,
      }));

    case "text":
      return data.map((text) => ({
        text: text.text,
        confidence: text.confidence,
      }));

    default:
      return data;
  }
}

// Function to extract property details using ChatGPT
async function extractPropertyDetailsWithChatGPT(
  transcription,
  labelSummary,
  textSummary
) {
  try {
    console.log(
      `[${new Date().toISOString()}] 🤖 Starting multi-stage ChatGPT analysis`
    );

    // Clean data for API calls
    const cleanedLabels = cleanDataForAPI(labelSummary, "labels");
    const cleanedText = cleanDataForAPI(textSummary, "text");

    // 1. Analyze Transcription
    const transcriptionAnalysis = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "system",
          content:
            "You are a professional real estate analyst. Your task is to analyze property video transcription data and extract key information about the property.",
        },
        {
          role: "user",
          content: `
            Analyze this property video transcription and extract key information about the property.
            Focus on:
            - Property type and style
            - Room descriptions and features
            - Notable amenities and upgrades
            - Price information
            - Location details
            - Any specific property characteristics mentioned

            Transcription:
            ${transcription || "No transcription available"}

            Return a JSON object with:
            {
              "propertyType": "Inferred property type",
              "style": "Architectural style",
              "rooms": ["List of rooms mentioned"],
              "features": ["List of features mentioned"],
              "amenities": ["List of amenities mentioned"],
              "price": "Any price information",
              "location": "Location details",
              "specialCharacteristics": ["Unique features mentioned"],
              "confidence": "Overall confidence in analysis (0-100)",
              "reasoning": "Explanation of how conclusions were drawn"
            }`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    // 2. Analyze Label Detection
    const labelAnalysis = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "system",
          content:
            "You are a professional real estate analyst. Your task is to analyze property video label detection data and extract key information about the property's features and characteristics.",
        },
        {
          role: "user",
          content: `
            Analyze this property video label detection data and extract key information about the property.
            Focus on:
            - Room types and spaces
            - Architectural features
            - Design elements
            - Property style indicators
            - Quality and condition indicators

            Label Detection Data:
            ${JSON.stringify(cleanedLabels, null, 2)}

            Return a JSON object with:
            {
              "roomTypes": ["List of detected room types"],
              "architecturalFeatures": ["List of architectural features"],
              "designElements": ["List of design elements"],
              "styleIndicators": ["List of style indicators"],
              "qualityIndicators": ["List of quality indicators"],
              "confidence": "Overall confidence in analysis (0-100)",
              "reasoning": "Explanation of how conclusions were drawn"
            }`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    // 3. Analyze Text Detection
    const textAnalysis = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "system",
          content:
            "You are a professional real estate analyst. Your task is to analyze property video text detection data and extract key information about the property's features and specifications.",
        },
        {
          role: "user",
          content: `
            Analyze this property video text detection data and extract key information about the property.
            Focus on:
            - Property specifications
            - Room labels and signs
            - Price information
            - Address and location details
            - Any visible property information

            Text Detection Data:
            ${JSON.stringify(cleanedText, null, 2)}

            Return a JSON object with:
            {
              "specifications": ["List of property specifications"],
              "roomLabels": ["List of room labels"],
              "priceInformation": "Any price information",
              "locationDetails": "Location information",
              "visibleInformation": ["List of visible property information"],
              "confidence": "Overall confidence in analysis (0-100)",
              "reasoning": "Explanation of how conclusions were drawn"
            }`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    // 4. Generate Final Property Analysis with GPT-4 for complex reasoning
    const finalAnalysis = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "system",
          content:
            "You are a professional real estate analyst. Your task is to combine multiple data sources to create a comprehensive property analysis. Use your expertise to make intelligent inferences and connections between different data points.",
        },
        {
          role: "user",
          content: `
            Combine these property analysis results to create a comprehensive property listing.
            Use all available data to make informed inferences about the property.
            Look for patterns and relationships between different data sources to draw stronger conclusions.

            Transcription Analysis:
            ${transcriptionAnalysis.choices[0].message.content}

            Label Detection Analysis:
            ${labelAnalysis.choices[0].message.content}

            Text Detection Analysis:
            ${textAnalysis.choices[0].message.content}

            Return a detailed JSON object with:
            {
              "propertyOverview": {
                "type": {
                  "value": "Infer property type (e.g., Single Family Home, Condo, etc.)",
                  "confidence": "0-100",
                  "reasoning": "Explain how this was determined"
                },
                "style": {
                  "value": "Architectural style based on visual elements and descriptions",
                  "confidence": "0-100",
                  "reasoning": "Explain style indicators"
                },
                "condition": {
                  "value": "Overall condition (Excellent, Good, Fair, etc.)",
                  "confidence": "0-100",
                  "reasoning": "List condition indicators"
                }
              },
              "specifications": {
                "bedrooms": {
                  "value": "number",
                  "confidence": "0-100",
                  "reasoning": "Evidence for bedroom count"
                },
                "bathrooms": {
                  "value": "number",
                  "confidence": "0-100",
                  "reasoning": "Evidence for bathroom count"
                },
                "squareFootage": {
                  "value": "total sq ft",
                  "confidence": "0-100",
                  "reasoning": "Size indicators"
                },
                "yearBuilt": {
                  "value": "year",
                  "confidence": "0-100",
                  "reasoning": "Age indicators"
                },
                "lotSize": {
                  "value": "acres/sq ft",
                  "confidence": "0-100",
                  "reasoning": "Lot size indicators"
                }
              },
              "features": {
                "interior": ["List with confidence scores"],
                "exterior": ["List with confidence scores"],
                "upgrades": ["List with confidence scores"],
                "amenities": ["List with confidence scores"]
              },
              "roomAnalysis": [
                {
                  "room": "name",
                  "features": ["detailed features"],
                  "condition": "condition assessment",
                  "highlights": ["notable elements"],
                  "confidence": "0-100"
                }
              ],
              "constructionDetails": {
                "materials": ["List with confidence scores"],
                "quality": {
                  "value": "assessment",
                  "confidence": "0-100"
                },
                "specialFeatures": ["List with confidence scores"]
              },
              "locationContext": {
                "setting": {
                  "value": "Urban/Suburban/Rural",
                  "confidence": "0-100"
                },
                "surroundings": ["Notable elements"]
              }
            }

            Guidelines:
            1. Use all available data sources to make informed inferences
            2. Look for patterns and correlations between different data sources
            3. When information is unclear, use multiple data points to make educated estimates
            4. Provide detailed reasoning that references specific data points
            5. Consider the reliability and confidence of each data source
            6. Format numbers consistently (e.g., "2,500" for square footage)
            7. Use proper capitalization and complete sentences in descriptions
            8. Ensure all JSON is properly formatted
            9. Return only the JSON object, no additional text`,
        },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    });

    // Parse and validate the final analysis
    let finalJson;
    try {
      // Clean the response text
      let cleanedText = finalAnalysis.choices[0].message.content.trim();

      // Remove any text before the first {
      const firstBraceIndex = cleanedText.indexOf("{");
      if (firstBraceIndex === -1) {
        throw new Error("No JSON object found in response");
      }
      cleanedText = cleanedText.substring(firstBraceIndex);

      // Remove any text after the last }
      const lastBraceIndex = cleanedText.lastIndexOf("}");
      if (lastBraceIndex === -1) {
        throw new Error("Invalid JSON structure - missing closing brace");
      }
      cleanedText = cleanedText.substring(0, lastBraceIndex + 1);

      // Remove any markdown code block indicators
      cleanedText = cleanedText.replace(/```json\s*|\s*```/g, "");

      // Remove any explanatory text or comments
      cleanedText = cleanedText.replace(/\/\/.*$/gm, "");

      // Try to parse the cleaned JSON
      finalJson = JSON.parse(cleanedText);

      // Validate required fields
      if (!finalJson.propertyOverview || !finalJson.specifications) {
        throw new Error("Missing required sections in response");
      }

      // Validate and clean up confidence scores
      const cleanConfidenceScores = (obj) => {
        if (typeof obj === "object" && obj !== null) {
          Object.keys(obj).forEach((key) => {
            if (key === "confidence" && typeof obj[key] === "string") {
              // Convert confidence string to number
              const score = parseInt(obj[key]);
              obj[key] = isNaN(score) ? 0 : score;
            } else {
              cleanConfidenceScores(obj[key]);
            }
          });
        }
      };

      cleanConfidenceScores(finalJson);

      return finalJson;
    } catch (parseError) {
      console.error(
        `[${new Date().toISOString()}] ❌ JSON parsing error:`,
        parseError
      );
      console.error("Raw response:", finalAnalysis.choices[0].message.content);
      throw new Error(`Failed to parse JSON response: ${parseError.message}`);
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error in enhanced property analysis:`,
      error
    );
    throw error;
  }
}

// Function to generate and save formatted document to Google Drive
async function generateAndSaveDocument(propertyDetails, driveFileId, fileName) {
  try {
    console.log(
      `[${new Date().toISOString()}] 📝 Generating formatted document...`
    );

    // Clean up any markdown or special characters in the property details
    const cleanPropertyDetails = JSON.parse(JSON.stringify(propertyDetails));
    const cleanMarkdown = (obj) => {
      if (typeof obj === "string") {
        return obj
          .replace(/\*\*/g, "") // Remove bold markdown
          .replace(/\*/g, "") // Remove italic markdown
          .replace(/`/g, "") // Remove code markdown
          .replace(/\[|\]/g, "") // Remove square brackets
          .replace(/#{1,6}\s/g, "") // Remove heading markdown
          .replace(/\n\s*[-*+]\s/g, "\n• ") // Convert markdown lists to bullet points
          .trim();
      }
      if (typeof obj === "object" && obj !== null) {
        Object.keys(obj).forEach((key) => {
          obj[key] = cleanMarkdown(obj[key]);
        });
      }
      return obj;
    };

    const cleanedDetails = cleanMarkdown(cleanPropertyDetails);

    const prompt = `
      Create a factual property listing document based on video analysis and transcript data.
      Focus on objective features and details observed in the video.
      
      Property Description
      [Write a detailed factual description based on video analysis and transcript. Include:
      - Property type and style
      - Key structural features
      - Notable materials and finishes
      - Room layout and flow
      - Any unique architectural elements
      - Observed condition and maintenance
      Focus on facts, not marketing language]

      Property Details
      Type: [Property Type]
      Style: [Architectural Style]
      Year Built: [Year]
      Square Footage: [Size]
      Lot Size: [Size]
      Bedrooms: [Number]
      Bathrooms: [Number]
      Condition: [Condition]

      Features
      Interior:
      • [List all observed interior features, materials, and finishes]

      Exterior:
      • [List all observed exterior features, materials, and finishes]

      Rooms
      [List each room with all observed features, including:
      - Dimensions (if visible)
      - Materials and finishes
      - Built-in features
      - Natural light sources
      - Flooring type
      - Ceiling features]

      Location
      Setting: [Urban/Suburban/Rural]
      • [List all observed location features, including:
      - Street type and condition
      - Surrounding structures
      - Natural features
      - Access points
      - Parking arrangements]`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "system",
          content:
            "You are a property analyst. Create detailed, factual property listings based on video analysis and transcript data. Focus on objective features and avoid marketing language. Do not use any markdown formatting in your response.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    let formattedContent = completion.choices[0].message.content;

    // Post-process the content to ensure clean formatting
    formattedContent = formattedContent
      .replace(/<[^>]*>/g, "") // Remove any HTML tags
      .replace(/\r\n/g, "\n") // Normalize line breaks
      .replace(/\n{3,}/g, "\n\n") // Remove excessive line breaks
      .replace(/^([A-Z][A-Z\s&]+)$/gm, "$1") // Preserve section headers
      .replace(/•\s*/g, "• ") // Standardize bullet points
      .replace(/[-_]\s/g, "• ") // Convert dashes and underscores at start of lines to bullets
      .trim();

    try {
      console.log(
        `[${new Date().toISOString()}] 📄 Creating document in folder: ${driveFileId}`
      );

      const fileMetadata = {
        name: `${fileName.split(".")[0]} - MLS Listing`,
        parents: [PROPERTY_ANALYSIS_FOLDER_ID],
        mimeType: "application/vnd.google-apps.document",
      };

      // Create an empty Google Doc
      const file = await drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: "application/vnd.google-apps.document",
          body: "",
        },
        fields: "id, name, webViewLink",
      });

      const docs = google.docs({ version: "v1", auth });

      // Insert content first
      await docs.documents.batchUpdate({
        documentId: file.data.id,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: formattedContent,
              },
            },
          ],
        },
      });

      // Get the document to find section locations
      const document = await docs.documents.get({
        documentId: file.data.id,
      });

      // Prepare styling requests
      const requests = [];
      let currentIndex = 1;

      // Process each paragraph
      document.data.body.content.forEach((element) => {
        if (element.paragraph) {
          const text = element.paragraph.elements[0].textRun?.content || "";
          const trimmedText = text.trim();

          // Check if this is a section header (all caps)
          if (trimmedText.match(/^[A-Z][A-Z\s&]+$/)) {
            requests.push({
              updateParagraphStyle: {
                range: {
                  startIndex: currentIndex,
                  endIndex: currentIndex + text.length,
                },
                paragraphStyle: {
                  namedStyleType: "HEADING_2",
                },
                fields: "namedStyleType",
              },
            });
          }

          currentIndex += text.length;
        }
      });

      // Apply styles if there are any
      if (requests.length > 0) {
        await docs.documents.batchUpdate({
          documentId: file.data.id,
          requestBody: { requests },
        });
      }

      // Make the file publicly accessible
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
      });

      // Get the public link
      const fileDetails = await drive.files.get({
        fileId: file.data.id,
        fields: "id, name, webViewLink, webContentLink",
      });

      console.log(
        `[${new Date().toISOString()}] ✅ Document created successfully:`,
        `\nID: ${fileDetails.data.id}`,
        `\nName: ${fileDetails.data.name}`,
        `\nView Link: ${fileDetails.data.webViewLink}`,
        `\nDownload Link: ${fileDetails.data.webContentLink}`
      );

      return {
        fileId: fileDetails.data.id,
        viewLink: fileDetails.data.webViewLink,
        downloadLink: fileDetails.data.webContentLink,
      };
    } catch (createError) {
      console.error(
        `[${new Date().toISOString()}] ❌ Document creation error:`,
        createError.message
      );
      throw new Error(`Failed to create document: ${createError.message}`);
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error generating document:`,
      error
    );
    throw error;
  }
}

// Function to process a video
async function processVideo(
  bucketName,
  fileName,
  messageId,
  driveFileId = null
) {
  console.log(
    `[${new Date().toISOString()}] 🎥 Processing video: ${fileName} (Message ID: ${messageId})`
  );

  // Log Drive file ID if available
  if (driveFileId) {
    console.log(
      `[${new Date().toISOString()}] 🔗 Google Drive file ID: ${driveFileId}`
    );
  }

  // Get the GCS URI for the video
  const gcsUri = `gs://${bucketName}/${fileName}`;

  // Check if the file exists in GCS before processing
  try {
    const [exists] = await storage.bucket(bucketName).file(fileName).exists();
    if (!exists) {
      throw new Error(`File not found in bucket: ${fileName}`);
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error checking file existence:`,
      error.message
    );
    throw new Error(`Failed to access file ${fileName}: ${error.message}`);
  }

  // Request video annotation for transcription
  const transcriptionRequest = {
    inputUri: gcsUri,
    features: ["SPEECH_TRANSCRIPTION"],
    videoContext: {
      speechTranscriptionConfig: {
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
      },
    },
  };

  // Request video annotation for label detection
  const labelDetectionRequest = {
    inputUri: gcsUri,
    features: ["LABEL_DETECTION"],
  };

  // Request video annotation for text detection
  const textDetectionRequest = {
    inputUri: gcsUri,
    features: ["TEXT_DETECTION"],
  };

  try {
    // Start all video annotation operations
    console.log(`[${new Date().toISOString()}] 🔄 Starting video analysis...`);
    const [transcriptionOperation] = await videoClient.annotateVideo(
      transcriptionRequest
    );
    const [labelDetectionOperation] = await videoClient.annotateVideo(
      labelDetectionRequest
    );
    const [textDetectionOperation] = await videoClient.annotateVideo(
      textDetectionRequest
    );

    console.log(
      `[${new Date().toISOString()}] ⏳ Waiting for all operations to complete...`
    );

    // Wait for all operations to complete
    const [transcriptionResponse] = await transcriptionOperation.promise();
    const [labelDetectionResponse] = await labelDetectionOperation.promise();
    const [textDetectionResponse] = await textDetectionOperation.promise();

    console.log(`[${new Date().toISOString()}] ✅ Video analysis completed`);

    const transcriptionResults = transcriptionResponse.annotationResults[0];
    const labelDetectionResults = labelDetectionResponse.annotationResults[0];
    const textDetectionResults = textDetectionResponse.annotationResults[0];

    if (!transcriptionResults) {
      throw new Error(
        "No transcription results returned from Video Intelligence API"
      );
    }

    // Get the full transcription
    const transcription =
      transcriptionResults.speechTranscriptions
        ?.map(
          (transcription) => transcription.alternatives[0]?.transcript || ""
        )
        .join(" ") || "";

    // Extract label detection information
    const detectedLabels = (
      labelDetectionResults?.segmentLabelAnnotations || []
    ).map((segment) => ({
      description: segment.entity.description,
      confidence: segment.segments[0].confidence,
      timestamp: segment.segments[0].segment.startTimeOffset.seconds,
    }));

    // Extract text detection information
    const detectedText = (textDetectionResults?.textAnnotations || []).map(
      (text) => ({
        text: text.text,
        confidence: text.confidence,
        timestamp: text.segments[0].segment.startTimeOffset.seconds,
      })
    );

    // Store raw analysis results in Firestore
    console.log(
      `[${new Date().toISOString()}] 📝 Storing raw analysis in Firestore...`
    );
    const firestoreId = await firestoreService.storeVideoAnalysis(fileName, {
      transcription,
      labels: detectedLabels,
      text: detectedText,
      driveFileId,
    });

    // Check if we got a fallback ID
    const isFallbackId =
      firestoreId.startsWith("fallback_") || firestoreId.startsWith("error_");
    if (isFallbackId) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ Using fallback storage ID: ${firestoreId}`
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] ✅ Raw analysis stored in Firestore with ID: ${firestoreId}`
      );
    }

    // Extract property details using ChatGPT
    console.log(`[${new Date().toISOString()}] 🤖 Processing with ChatGPT...`);
    const propertyDetails = await extractPropertyDetailsWithChatGPT(
      transcription,
      detectedLabels,
      detectedText
    );
    console.log(`[${new Date().toISOString()}] ✅ ChatGPT analysis completed`);

    // Generate and save formatted document to Google Drive
    console.log(
      `[${new Date().toISOString()}] 📝 Generating and saving formatted document...`
    );
    const documentId = await generateAndSaveDocument(
      propertyDetails,
      driveFileId,
      fileName
    );
    console.log(
      `[${new Date().toISOString()}] ✅ Formatted document saved to Google Drive`
    );

    // Store processed analysis in Firestore
    console.log(
      `[${new Date().toISOString()}] 📝 Storing processed analysis in Firestore...`
    );
    const processedAnalysisId = await firestoreService.storeProcessedAnalysis(
      fileName,
      firestoreId,
      propertyDetails,
      driveFileId,
      {
        simplifiedSummary: {
          type:
            propertyDetails.propertyOverview?.type?.value || "Not specified",
          style:
            propertyDetails.propertyOverview?.style?.value || "Not specified",
          bedrooms:
            propertyDetails.specifications?.bedrooms?.value || "Not specified",
          squareFootage:
            propertyDetails.specifications?.squareFootage?.value ||
            "Not specified",
          roomCount: propertyDetails.roomAnalysis?.length || 0,
        },
        categorizedLabels: detectedLabels,
        detectedText: detectedText,
        isFallbackStorage: isFallbackId,
      }
    );
    console.log(
      `[${new Date().toISOString()}] ✅ Processed analysis stored in Firestore with ID: ${processedAnalysisId}`
    );

    // Log a brief summary of the property details
    console.log(
      `[${new Date().toISOString()}] 📊 Property details: ${
        propertyDetails.propertyOverview?.type?.value || "Unknown type"
      }, ${
        propertyDetails.propertyOverview?.style?.value || "Unknown style"
      }, ${
        propertyDetails.specifications?.bedrooms?.value || "Unknown bedrooms"
      } beds`
    );

    // Mark file as processed
    processedFiles.add(fileName);
    console.log(
      `[${new Date().toISOString()}] ✅ Successfully processed file: ${fileName}`
    );

    return {
      success: true,
      transcription,
      propertyDetails,
      simplifiedSummary: {
        type: propertyDetails.propertyOverview?.type?.value || "Not specified",
        style:
          propertyDetails.propertyOverview?.style?.value || "Not specified",
        bedrooms:
          propertyDetails.specifications?.bedrooms?.value || "Not specified",
        squareFootage:
          propertyDetails.specifications?.squareFootage?.value ||
          "Not specified",
        roomCount: propertyDetails.roomAnalysis?.length || 0,
      },
      firestoreId,
      processedAnalysisId,
    };
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error processing video:`,
      error.message
    );
    failedFiles.add(fileName);
    throw error;
  }
}

// Function to process the queue
async function processQueue() {
  if (isProcessing || processingQueue.length === 0) {
    return;
  }

  isProcessing = true;
  console.log(
    `[${new Date().toISOString()}] 🔄 Starting queue processing. Queue length: ${
      processingQueue.length
    }`
  );

  try {
    const { bucketName, fileName, res, messageId, driveFileId } =
      processingQueue.shift();

    try {
      // Mark the message as processed BEFORE processing to prevent duplicates
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed BEFORE processing`
        );
      }

      const result = await processVideo(
        bucketName,
        fileName,
        messageId,
        driveFileId
      );

      // Return success response
      res.status(200).json({
        message: "Video processed successfully",
        ...result,
      });
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error processing video:`,
        error.message
      );
      res.status(500).json({
        error: "Failed to process video",
        details: error.message,
      });
    }
  } finally {
    isProcessing = false;

    // Process next item in queue after a delay
    if (processingQueue.length > 0) {
      console.log(
        `[${new Date().toISOString()}] ⏱️ Queue still has ${
          processingQueue.length
        } items. Waiting 12 seconds before processing next item.`
      );
      // Wait at least 12 seconds between processing videos
      setTimeout(processQueue, 12000);
    } else {
      console.log(
        `[${new Date().toISOString()}] ✅ Queue processing complete. Queue is now empty.`
      );
    }
  }
}

app.post("/", async (req, res) => {
  try {
    const bucketName = req.body.bucket;
    const fileName = req.body.name;
    const messageId = req.messageId; // Get the message ID from the request
    const driveFileId = req.body.driveFileId || null; // Extract Drive file ID from request

    if (!fileName) {
      console.error(
        `[${new Date().toISOString()}] ❌ No fileName provided in request`
      );
      return res.status(400).json({
        error: "Missing fileName in request",
        details: "The request must include a 'name' field",
      });
    }

    // Check if file has already been processed successfully
    if (processedFiles.has(fileName)) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ File ${fileName} has already been processed successfully, skipping`
      );
      return res.status(200).json({
        message: "File already processed",
        fileName: fileName,
      });
    }

    // Add the video to the processing queue
    processingQueue.push({ bucketName, fileName, res, messageId, driveFileId });

    // Process the queue
    processQueue();
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error processing request:`,
      error.message
    );
    res.status(500).json({
      error: "Failed to process request",
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
