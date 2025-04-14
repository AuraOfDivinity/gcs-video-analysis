const { Storage } = require("@google-cloud/storage");
const videoIntelligence = require("@google-cloud/video-intelligence");
const { API_CONFIG, API_FEATURES } = require("../config/constants");

const storage = new Storage();
const videoClient = new videoIntelligence.VideoIntelligenceServiceClient();

class VideoAnalysisService {
  constructor() {
    this.processedFiles = new Set();
    this.failedFiles = new Set();
    this.processedMessageIds = new Set();
  }

  async analyzeVideo(bucketName, fileName, messageId) {
    console.log(
      `[${new Date().toISOString()}] 🎥 Processing video: ${fileName} (Message ID: ${messageId})`
    );

    const gcsUri = `gs://${bucketName}/${fileName}`;

    // Create requests for each analysis type
    const requests = {
      transcription: {
        inputUri: gcsUri,
        features: API_FEATURES.TRANSCRIPTION,
        videoContext: {
          speechTranscriptionConfig: {
            languageCode: API_CONFIG.LANGUAGE_CODE,
            enableAutomaticPunctuation: API_CONFIG.ENABLE_AUTOMATIC_PUNCTUATION,
          },
        },
      },
      objectTracking: {
        inputUri: gcsUri,
        features: API_FEATURES.OBJECT_TRACKING,
      },
      labelDetection: {
        inputUri: gcsUri,
        features: API_FEATURES.LABEL_DETECTION,
      },
      textDetection: {
        inputUri: gcsUri,
        features: API_FEATURES.TEXT_DETECTION,
      },
    };

    try {
      // Start all video annotation operations
      console.log(
        `[${new Date().toISOString()}] 🔄 Starting video analysis...`
      );
      const operations = await Promise.all(
        Object.values(requests).map((request) =>
          videoClient.annotateVideo(request)
        )
      );

      console.log(
        `[${new Date().toISOString()}] ⏳ Waiting for all operations to complete...`
      );
      const responses = await Promise.all(
        operations.map(([operation]) => operation.promise())
      );

      console.log(`[${new Date().toISOString()}] ✅ Video analysis completed`);

      // Process results
      const results = {
        transcription: this.processTranscriptionResults(
          responses[0].annotationResults[0]
        ),
        objects: this.processObjectTrackingResults(
          responses[1].annotationResults[0]
        ),
        labels: this.processLabelDetectionResults(
          responses[2].annotationResults[0]
        ),
        text: this.processTextDetectionResults(
          responses[3].annotationResults[0]
        ),
      };

      // Display analysis summary
      this.displayAnalysisSummary(results);

      return results;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error analyzing video:`,
        error.message
      );
      this.failedFiles.add(fileName);
      throw error;
    }
  }

  processTranscriptionResults(results) {
    if (!results) {
      throw new Error(
        "No transcription results returned from Video Intelligence API"
      );
    }

    return (
      results.speechTranscriptions
        ?.map(
          (transcription) => transcription.alternatives[0]?.transcript || ""
        )
        .join(" ") || ""
    );
  }

  processObjectTrackingResults(results) {
    return (results?.objectAnnotations || []).map((track) => ({
      description: track.entity.description,
      confidence: track.frames[0].normalizedBoundingBox.confidence,
      timestamp: track.frames[0].timeOffset.seconds,
    }));
  }

  processLabelDetectionResults(results) {
    return (results?.segmentLabelAnnotations || []).map((segment) => ({
      description: segment.entity.description,
      confidence: segment.segments[0].confidence,
      timestamp: segment.segments[0].segment.startTimeOffset.seconds,
    }));
  }

  processTextDetectionResults(results) {
    return (results?.textAnnotations || []).map((text) => ({
      text: text.text,
      confidence: text.confidence,
      timestamp: text.segments[0].segment.startTimeOffset.seconds,
    }));
  }

  displayAnalysisSummary(results) {
    console.log(`\n[${new Date().toISOString()}] 📊 Analysis Summary:`);
    console.log(`Transcription: ${results.transcription.length} characters`);
    console.log(`Detected Objects: ${results.objects.length} items`);
    console.log(`Detected Labels: ${results.labels.length} scenes/features`);
    console.log(`Detected Text: ${results.text.length} text segments`);
  }
}

module.exports = new VideoAnalysisService();
