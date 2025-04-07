const express = require("express");
const { Storage } = require("@google-cloud/storage");
const videoIntelligence = require("@google-cloud/video-intelligence");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

// Middleware to parse Pub/Sub messages
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] 🔄 Received request: ${req.method} ${
      req.path
    }`
  );

  if (req.body.message && req.body.message.data) {
    try {
      // Store the message ID for deduplication
      const messageId = req.body.message.messageId;
      console.log(
        `[${new Date().toISOString()}] 📨 Pub/Sub message ID: ${messageId}`
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
        `[${new Date().toISOString()}] 📦 Decoded Pub/Sub message: bucket=${
          req.body.bucket
        }, file=${req.body.name}`
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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to extract property details using Gemini
async function extractPropertyDetailsWithGemini(transcription) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const prompt = `
    You are a real estate property analyzer. Based on the following video transcription, 
    extract the property details in a structured format. If any information is not explicitly mentioned, 
    leave that field empty.

    Video Transcription:
    ${transcription}

    Please extract and return ONLY a JSON object with the following structure:
    {
      "type": "property type (e.g., Single Family Home, Condo, etc.)",
      "style": "architectural style (e.g., Modern Farmhouse, Colonial, etc.)",
      "bedrooms": "number of bedrooms",
      "bathrooms": "number of bathrooms",
      "squareFootage": "total square footage",
      "yearBuilt": "year the property was built",
      "lotSize": "lot size in acres",
      "features": ["list of key features mentioned"],
      "description": "brief property description",
      "roomDetails": [
        {
          "room": "room name",
          "features": ["list of features mentioned for this room"],
          "description": "brief description of the room"
        }
      ]
    }

    Only return the JSON object, nothing else.
  `;

  try {
    console.log(
      `[${new Date().toISOString()}] 🤖 Calling Gemini API for property analysis`
    );
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Extract the JSON object from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("Failed to parse Gemini response as JSON");
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error extracting property details with Gemini:`,
      error
    );
    throw error;
  }
}

// Function to process a video
async function processVideo(bucketName, fileName) {
  console.log(`[${new Date().toISOString()}] 🎥 Processing video: ${fileName}`);

  // Get the GCS URI for the video
  const gcsUri = `gs://${bucketName}/${fileName}`;
  console.log(`[${new Date().toISOString()}] 🔗 GCS URI: ${gcsUri}`);

  // Request video annotation - ONLY TRANSCRIPTION
  const request = {
    inputUri: gcsUri,
    features: ["SPEECH_TRANSCRIPTION"],
    videoContext: {
      speechTranscriptionConfig: {
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
      },
    },
  };

  console.log(
    `[${new Date().toISOString()}] 🚀 Starting video transcription request`
  );

  try {
    // Start the video annotation operation
    console.log(
      `[${new Date().toISOString()}] 🔄 Calling Video Intelligence API`
    );
    const [operation] = await videoClient.annotateVideo(request);

    console.log(
      `[${new Date().toISOString()}] ⏳ Waiting for transcription to complete...`
    );

    // Wait for the operation to complete
    const [response] = await operation.promise();

    console.log(
      `[${new Date().toISOString()}] ✅ Video transcription completed`
    );

    const annotationResults = response.annotationResults[0];
    if (!annotationResults) {
      throw new Error(
        "No transcription results returned from Video Intelligence API"
      );
    }

    // Get the full transcription
    const transcription =
      annotationResults.speechTranscriptions
        ?.map((transcription) => transcription.alternatives[0].transcript)
        .join("\n") || "";

    console.log(
      `[${new Date().toISOString()}] 📝 Transcription extracted (${
        transcription.length
      } characters)`
    );

    // Extract property details using Gemini
    const propertyDetails = await extractPropertyDetailsWithGemini(
      transcription
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
    const { bucketName, fileName, res, messageId } = processingQueue.shift();
    console.log(
      `[${new Date().toISOString()}] 🔄 Processing queue item: ${fileName} (Message ID: ${
        messageId || "N/A"
      })`
    );

    try {
      const result = await processVideo(bucketName, fileName);

      // Mark the message as processed
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed`
        );
      }

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
    console.log(`[${new Date().toISOString()}] 📥 Received POST request`);

    const bucketName = req.body.bucket;
    const fileName = req.body.name;
    const messageId = req.messageId; // Get the message ID from the request

    if (!fileName) {
      console.error(
        `[${new Date().toISOString()}] ❌ No fileName provided in request`
      );
      return res.status(400).json({
        error: "Missing fileName in request",
        details: "The request must include a 'name' field",
      });
    }

    console.log(
      `[${new Date().toISOString()}] 📄 Processing request for file: ${fileName} (Message ID: ${
        messageId || "N/A"
      })`
    );

    // Check if file has already been processed successfully
    if (processedFiles.has(fileName)) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ File ${fileName} has already been processed successfully, skipping`
      );
      // Mark the message as processed even if we skip the file
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed (file already processed)`
        );
      }
      return res.status(200).json({
        message: "File already processed successfully",
        fileName: fileName,
      });
    }

    // Check if file has already failed processing
    if (failedFiles.has(fileName)) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ File ${fileName} has already failed processing, skipping`
      );
      // Mark the message as processed even if we skip the file
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed (file already failed)`
        );
      }
      return res.status(200).json({
        message: "File has already failed processing",
        fileName: fileName,
      });
    }

    // Check if the file is a video
    const videoExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const isVideo = videoExtensions.some((ext) =>
      fileName.toLowerCase().endsWith(ext)
    );

    if (!isVideo) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ File ${fileName} is not a video, skipping processing`
      );
      // Mark the message as processed even if we skip the file
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed (not a video)`
        );
      }
      return res.status(200).json({
        message: "File is not a video, skipping processing",
        fileName: fileName,
      });
    }

    // Check if the queue is too large
    if (processingQueue.length >= MAX_QUEUE_SIZE) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ Queue is full (${
          processingQueue.length
        } items), rejecting new request`
      );
      // Mark the message as processed even if we reject it
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed (queue full)`
        );
      }
      return res.status(429).json({
        error: "Processing queue is full",
        details:
          "The system is currently processing too many videos. Please try again later.",
      });
    }

    // Check if this file is already in the queue
    const isInQueue = processingQueue.some(
      (item) => item.fileName === fileName
    );
    if (isInQueue) {
      console.log(
        `[${new Date().toISOString()}] ⚠️ File ${fileName} is already in the processing queue, skipping`
      );
      // Mark the message as processed even if we skip the file
      if (messageId) {
        processedMessageIds.add(messageId);
        console.log(
          `[${new Date().toISOString()}] ✅ Marked message ID ${messageId} as processed (already in queue)`
        );
      }
      return res.status(200).json({
        message: "File is already in the processing queue",
        fileName: fileName,
      });
    }

    // Add to processing queue
    processingQueue.push({ bucketName, fileName, res, messageId });
    console.log(
      `[${new Date().toISOString()}] ➕ Added ${fileName} to processing queue. Queue length: ${
        processingQueue.length
      }`
    );

    // Start processing the queue if not already processing
    processQueue();
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Error handling request:`,
      error.message
    );
    res.status(500).json({
      error: "Failed to handle request",
      details: error.message,
    });
  }
});

// Add a health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    queueLength: processingQueue.length,
    processedFiles: Array.from(processedFiles),
    failedFiles: Array.from(failedFiles),
    processedMessageIds: Array.from(processedMessageIds),
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(
    `[${new Date().toISOString()}] 🚀 Video processor service listening on port ${PORT}`
  );
});
