const express = require("express");
const { Storage } = require("@google-cloud/storage");
const videoIntelligence = require("@google-cloud/video-intelligence");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const firestoreService = require("./services/firestoreService");

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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to filter and optimize video analysis data
function optimizeVideoData(trackedObjects, detectedLabels, detectedText) {
  // Ensure inputs are arrays and have the expected structure
  const objects = Array.isArray(trackedObjects) ? trackedObjects : [];
  const labels = Array.isArray(detectedLabels) ? detectedLabels : [];
  const text = Array.isArray(detectedText) ? detectedText : [];

  console.log(
    `[${new Date().toISOString()}] 🔍 Optimizing video data:`,
    `Objects: ${objects.length}, Labels: ${labels.length}, Text: ${text.length}`
  );

  // Filter and optimize object tracking data
  const optimizedObjects = objects.reduce((acc, obj) => {
    if (!obj || typeof obj !== "object") return acc;

    const key = (obj.description || "").toLowerCase();
    if (!key) return acc;

    if (!acc[key]) {
      acc[key] = {
        count: 0,
        confidence: 0,
        occurrences: [],
      };
    }
    // Only include frames at specified intervals
    if (obj.timestamp % FRAME_INTERVAL_SECONDS === 0) {
      acc[key].count++;
      acc[key].confidence += obj.confidence || 0;
      acc[key].occurrences.push(obj.timestamp);
    }
    return acc;
  }, {});

  // Calculate average confidence and filter low confidence objects
  Object.keys(optimizedObjects).forEach((key) => {
    if (optimizedObjects[key].count > 0) {
      optimizedObjects[key].confidence =
        optimizedObjects[key].confidence / optimizedObjects[key].count;
      if (optimizedObjects[key].confidence < CONFIDENCE_THRESHOLD) {
        delete optimizedObjects[key];
      }
    }
  });

  // Filter and optimize label detection data
  const optimizedLabels = labels
    .filter(
      (label) =>
        label &&
        typeof label === "object" &&
        (label.confidence || 0) >= CONFIDENCE_THRESHOLD
    )
    .reduce((acc, label) => {
      if (!label.timestamp) return acc;

      const segmentKey = Math.floor(label.timestamp / FRAME_INTERVAL_SECONDS);
      if (!acc[segmentKey]) {
        acc[segmentKey] = [];
      }
      if (acc[segmentKey].length < MAX_LABELS_PER_SEGMENT) {
        acc[segmentKey].push({
          description: label.description || "",
          confidence: label.confidence || 0,
          timestamp: label.timestamp,
        });
      }
      return acc;
    }, {});

  // Flatten and sort labels by confidence
  const flattenedLabels = Object.values(optimizedLabels)
    .flat()
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Filter and optimize text detection data
  const optimizedText = text
    .filter(
      (text) =>
        text &&
        typeof text === "object" &&
        (text.confidence || 0) >= CONFIDENCE_THRESHOLD
    )
    .map((text) => ({
      text: text.text || "",
      confidence: text.confidence || 0,
      timestamp: text.timestamp || 0,
    }));

  console.log(
    `[${new Date().toISOString()}] ✅ Optimized data:`,
    `Objects: ${Object.keys(optimizedObjects).length}, Labels: ${
      flattenedLabels.length
    }, Text: ${optimizedText.length}`
  );

  return {
    objects: optimizedObjects,
    labels: flattenedLabels,
    text: optimizedText,
  };
}

// Function to extract property details using Gemini
async function extractPropertyDetailsWithGemini(
  transcription,
  objectSummary,
  labelSummary,
  textSummary
) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  // Optimize the data before sending to Gemini
  const optimizedData = optimizeVideoData(
    objectSummary,
    labelSummary,
    textSummary
  );

  const prompt = `
    Analyze this property video and extract details in JSON format:

    Transcription: ${transcription}
    Objects: ${JSON.stringify(optimizedData.objects, null, 2)}
    Labels: ${JSON.stringify(optimizedData.labels, null, 2)}
    Text: ${JSON.stringify(optimizedData.text, null, 2)}

    Return a JSON object with:
    {
      "type": {
        "value": "property type",
        "confidence": "0-100"
      },
      "style": {
        "value": "architectural style",
        "confidence": "0-100"
      },
      "bedrooms": "number",
      "bathrooms": "number",
      "squareFootage": "total sq ft",
      "yearBuilt": "year",
      "lotSize": "acres",
      "features": ["key features"],
      "description": {
        "value": "Comprehensive description including: style, features, rooms, condition, updates, outdoor spaces, smart features, and location benefits",
        "confidence": "0-100"
      },
      "roomDetails": [
        {
          "room": "name",
          "features": ["features"],
          "description": "brief description",
          "confidence": "0-100"
        }
      ],
      "detectedObjects": {
        "furniture": ["item (count: X, confidence: Y%)"],
        "appliances": ["item (count: X, confidence: Y%)"],
        "fixtures": ["item (count: X, confidence: Y%)"],
        "other": ["item (count: X, confidence: Y%)"]
      },
      "detectedLabels": {
        "rooms": ["room (confidence: Y%)"],
        "styles": ["style (confidence: Y%)"],
        "materials": ["material (confidence: Y%)"],
        "features": ["feature (confidence: Y%)"],
        "other": ["label (confidence: Y%)"]
      },
      "detectedText": {
        "propertyDetails": ["text (confidence: Y%)"],
        "prices": ["price info"],
        "other": ["other text"]
      }
    }

    Only return the JSON object.`;

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

  // Request video annotation for object tracking
  const objectTrackingRequest = {
    inputUri: gcsUri,
    features: ["OBJECT_TRACKING"],
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
    const [objectTrackingOperation] = await videoClient.annotateVideo(
      objectTrackingRequest
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
    const [objectTrackingResponse] = await objectTrackingOperation.promise();
    const [labelDetectionResponse] = await labelDetectionOperation.promise();
    const [textDetectionResponse] = await textDetectionOperation.promise();

    console.log(`[${new Date().toISOString()}] ✅ Video analysis completed`);

    const transcriptionResults = transcriptionResponse.annotationResults[0];
    const objectTrackingResults = objectTrackingResponse.annotationResults[0];
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

    // Extract object tracking information
    const trackedObjects = (objectTrackingResults?.objectAnnotations || []).map(
      (track) => ({
        description: track.entity.description,
        confidence: track.frames[0].normalizedBoundingBox.confidence,
        timestamp: track.frames[0].timeOffset.seconds,
      })
    );

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

    // Filter and group objects by type
    const objectSummary = trackedObjects.reduce((acc, obj) => {
      const key = obj.description.toLowerCase();
      if (!acc[key]) {
        acc[key] = {
          count: 0,
          confidence: 0,
          occurrences: [],
        };
      }
      acc[key].count++;
      acc[key].confidence += obj.confidence;
      acc[key].occurrences.push(obj.timestamp);
      return acc;
    }, {});

    // Calculate average confidence for each object type
    Object.keys(objectSummary).forEach((key) => {
      objectSummary[key].confidence =
        objectSummary[key].confidence / objectSummary[key].count;
    });

    // Categorize objects into furniture, appliances, fixtures, and other
    const categorizedObjects = {
      furniture: [],
      appliances: [],
      fixtures: [],
      other: [],
    };

    const furnitureKeywords = [
      "chair",
      "table",
      "sofa",
      "couch",
      "bed",
      "desk",
      "cabinet",
      "dresser",
      "wardrobe",
      "bookshelf",
    ];
    const applianceKeywords = [
      "refrigerator",
      "stove",
      "oven",
      "dishwasher",
      "washer",
      "dryer",
      "microwave",
      "air conditioner",
    ];
    const fixtureKeywords = [
      "sink",
      "toilet",
      "bathtub",
      "shower",
      "faucet",
      "light",
      "fan",
      "vent",
    ];

    Object.entries(objectSummary).forEach(([object, data]) => {
      const objectLower = object.toLowerCase();
      if (furnitureKeywords.some((keyword) => objectLower.includes(keyword))) {
        categorizedObjects.furniture.push({ name: object, ...data });
      } else if (
        applianceKeywords.some((keyword) => objectLower.includes(keyword))
      ) {
        categorizedObjects.appliances.push({ name: object, ...data });
      } else if (
        fixtureKeywords.some((keyword) => objectLower.includes(keyword))
      ) {
        categorizedObjects.fixtures.push({ name: object, ...data });
      } else {
        categorizedObjects.other.push({ name: object, ...data });
      }
    });

    // Categorize labels into relevant property aspects
    const categorizedLabels = {
      rooms: [],
      styles: [],
      materials: [],
      features: [],
      other: [],
    };

    const roomKeywords = [
      "kitchen",
      "bedroom",
      "bathroom",
      "living room",
      "dining room",
      "garage",
      "basement",
    ];
    const styleKeywords = [
      "modern",
      "traditional",
      "contemporary",
      "classic",
      "minimalist",
      "rustic",
    ];
    const materialKeywords = [
      "wood",
      "marble",
      "granite",
      "stainless steel",
      "ceramic",
      "glass",
      "concrete",
    ];

    detectedLabels.forEach((label) => {
      const labelLower = label.description.toLowerCase();
      if (roomKeywords.some((keyword) => labelLower.includes(keyword))) {
        categorizedLabels.rooms.push({
          name: label.description,
          confidence: label.confidence,
        });
      } else if (
        styleKeywords.some((keyword) => labelLower.includes(keyword))
      ) {
        categorizedLabels.styles.push({
          name: label.description,
          confidence: label.confidence,
        });
      } else if (
        materialKeywords.some((keyword) => labelLower.includes(keyword))
      ) {
        categorizedLabels.materials.push({
          name: label.description,
          confidence: label.confidence,
        });
      } else if (
        labelLower.includes("feature") ||
        labelLower.includes("design")
      ) {
        categorizedLabels.features.push({
          name: label.description,
          confidence: label.confidence,
        });
      } else {
        categorizedLabels.other.push({
          name: label.description,
          confidence: label.confidence,
        });
      }
    });

    // Display summaries of extracted information
    console.log(`\n[${new Date().toISOString()}] 📊 Analysis Summary:`);
    console.log(`Transcription: ${transcription.length} characters`);
    console.log(
      `Detected Objects: ${Object.keys(objectSummary).length} unique items`
    );
    console.log(`Detected Labels: ${detectedLabels.length} scenes/features`);
    console.log(`Detected Text: ${detectedText.length} text segments`);

    // Create a simplified summary for verification
    const simplifiedSummary = {
      type: objectSummary.type || "Not specified",
      style: objectSummary.style || "Not specified",
      bedrooms: objectSummary.bedrooms || "Not specified",
      squareFootage: objectSummary.squareFootage || "Not specified",
      roomCount: objectSummary.roomDetails
        ? objectSummary.roomDetails.length
        : 0,
    };

    console.log(
      `[${new Date().toISOString()}] 📊 Simplified property summary:`,
      simplifiedSummary
    );

    // Store raw analysis results in Firestore
    console.log(
      `[${new Date().toISOString()}] 📝 Storing raw analysis in Firestore...`
    );
    const firestoreId = await firestoreService.storeVideoAnalysis(fileName, {
      transcription,
      objects: trackedObjects,
      labels: detectedLabels,
      text: detectedText,
      driveFileId, // Store Drive file ID in Firestore as well
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

    // Extract property details using Gemini
    console.log(`[${new Date().toISOString()}] 🤖 Processing with Gemini...`);
    const propertyDetails = await extractPropertyDetailsWithGemini(
      transcription,
      categorizedObjects,
      categorizedLabels,
      detectedText
    );
    console.log(`[${new Date().toISOString()}] ✅ Gemini analysis completed`);

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
        simplifiedSummary,
        categorizedObjects,
        categorizedLabels,
        detectedText,
        isFallbackStorage: isFallbackId,
      }
    );
    console.log(
      `[${new Date().toISOString()}] ✅ Processed analysis stored in Firestore with ID: ${processedAnalysisId}`
    );

    // Log a brief summary of the property details
    console.log(
      `[${new Date().toISOString()}] 📊 Property details: ${
        propertyDetails.type || "Unknown type"
      }, ${propertyDetails.style || "Unknown style"}, ${
        propertyDetails.bedrooms || "Unknown bedrooms"
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
      simplifiedSummary,
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
