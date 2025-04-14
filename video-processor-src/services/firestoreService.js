const { Firestore } = require("@google-cloud/firestore");

class FirestoreService {
  constructor() {
    // Initialize Firestore with ignoreUndefinedProperties enabled
    this.db = new Firestore({
      ignoreUndefinedProperties: true,
    });
    this.videoAnalysisCollection = "videoAnalysis";
    this.isInitialized = false;

    // Initialize Firestore on startup
    this.initializeFirestore().catch((err) => {
      console.error(
        `[${new Date().toISOString()}] ❌ Firestore initialization failed:`,
        err.message
      );
      // Don't throw the error, just log it and continue
      // We'll handle the error when trying to store data
    });
  }

  async initializeFirestore() {
    try {
      // Try to access the collection to verify connection
      const collectionRef = this.db.collection(this.videoAnalysisCollection);

      // Create a dummy document to ensure the collection exists
      const dummyDoc = collectionRef.doc("_initialization_check");
      await dummyDoc.set({
        timestamp: Firestore.FieldValue.serverTimestamp(),
        status: "initialization",
      });

      // Delete the dummy document
      await dummyDoc.delete();

      this.isInitialized = true;
      console.log(
        `[${new Date().toISOString()}] ✅ Firestore initialized successfully`
      );
    } catch (error) {
      // If the error is NOT_FOUND, it means the database doesn't exist
      if (error.code === 5) {
        console.error(
          `[${new Date().toISOString()}] ❌ Firestore database not found. Please ensure the database is created in the Google Cloud Console.`
        );
        console.error(
          `[${new Date().toISOString()}] ℹ️ You can create it by running: gcloud firestore databases create --region=${
            process.env.REGION || "us-central1"
          }`
        );
      } else {
        console.error(
          `[${new Date().toISOString()}] ❌ Firestore connection error:`,
          error.message
        );
      }
      // Don't throw the error, just log it and continue
      // We'll handle the error when trying to store data
    }
  }

  // Helper function to clean objects with undefined values
  cleanObject(obj) {
    if (obj === null || obj === undefined) {
      return null;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.cleanObject(item));
    }

    if (typeof obj === "object") {
      // Handle special types that Firestore can't serialize
      if (obj.constructor && obj.constructor.name === "Long") {
        return Number(obj.toString());
      }

      if (obj instanceof Date) {
        return obj.toISOString();
      }

      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        // Skip undefined values
        if (value !== undefined) {
          cleaned[key] = this.cleanObject(value);
        }
      }
      return cleaned;
    }

    return obj;
  }

  async storeVideoAnalysis(fileName, analysisResults) {
    try {
      // Ensure we have valid data to store
      if (!fileName || !analysisResults) {
        throw new Error("Invalid data provided for storage");
      }

      // If Firestore is not initialized, try to initialize it again
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] 🔄 Firestore not initialized, attempting to initialize...`
        );
        await this.initializeFirestore();
      }

      // If still not initialized, use a fallback mechanism
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Firestore still not initialized, using fallback mechanism`
        );
        // Store in memory or local file as fallback
        return this.storeFallback(fileName, analysisResults);
      }

      const docRef = this.db
        .collection(this.videoAnalysisCollection)
        .doc(fileName);

      // Clean all data before storing
      const cleanedObjects = this.cleanObject(analysisResults.objects || []);
      const cleanedLabels = this.cleanObject(analysisResults.labels || []);
      const cleanedText = this.cleanObject(analysisResults.text || []);

      // Create a clean object with only the data we want to store
      const unprocessedData = {
        transcription: analysisResults.transcription || "",
        objects: cleanedObjects,
        labels: cleanedLabels,
        text: cleanedText,
        driveFileId: analysisResults.driveFileId || null,
        timestamp: Firestore.FieldValue.serverTimestamp(),
      };

      // Store the data
      await docRef.set(
        {
          fileName,
          unprocessed: unprocessedData,
          status: "unprocessed",
          lastUpdated: Firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log(
        `[${new Date().toISOString()}] 📝 Stored unprocessed video analysis in Firestore for ${fileName}`
      );
      return docRef.id;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error storing video analysis in Firestore:`,
        error.message
      );
      throw error;
    }
  }

  // Fallback mechanism to store data when Firestore is not available
  async storeFallback(fileName, analysisResults) {
    try {
      // Create a simplified version of the data for fallback storage
      const fallbackData = {
        fileName,
        timestamp: new Date().toISOString(),
        transcription: analysisResults.transcription || "",
        objectsCount: (analysisResults.objects || []).length,
        labelsCount: (analysisResults.labels || []).length,
        textCount: (analysisResults.text || []).length,
        driveFileId: analysisResults.driveFileId || null,
        status: "processed_fallback",
      };

      // Log the fallback data
      console.log(
        `[${new Date().toISOString()}] 📝 Stored fallback data for ${fileName}:`,
        JSON.stringify(fallbackData)
      );

      // Return a fallback ID
      return `fallback_${fileName}_${Date.now()}`;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error in fallback storage:`,
        error.message
      );
      // Return a basic ID as a last resort
      return `error_${fileName}_${Date.now()}`;
    }
  }

  async getVideoAnalysis(fileName) {
    try {
      // If Firestore is not initialized, return null
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Firestore not initialized, cannot retrieve data`
        );
        return null;
      }

      const docRef = this.db
        .collection(this.videoAnalysisCollection)
        .doc(fileName);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      return doc.data();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error retrieving video analysis from Firestore:`,
        error.message
      );
      return null;
    }
  }

  async storeProcessedAnalysis(
    fileName,
    firestoreId,
    propertyDetails,
    driveFileId = null,
    metadata = {}
  ) {
    try {
      // Ensure we have valid data to store
      if (!fileName || !firestoreId || !propertyDetails) {
        throw new Error("Invalid data provided for storage");
      }

      // If Firestore is not initialized, try to initialize it again
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] 🔄 Firestore not initialized, attempting to initialize...`
        );
        await this.initializeFirestore();
      }

      // If still not initialized, use a fallback mechanism
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Firestore still not initialized, using fallback mechanism`
        );
        // Store in memory or local file as fallback
        return this.storeFallback(fileName, { propertyDetails, metadata });
      }

      const docRef = this.db
        .collection(this.videoAnalysisCollection)
        .doc(fileName);

      // Clean all data before storing
      const cleanedPropertyDetails = this.cleanObject(propertyDetails);
      const cleanedMetadata = this.cleanObject(metadata);

      // Create a clean object with only the data we want to store
      const processedData = {
        firestoreId,
        driveFileId,
        propertyDetails: cleanedPropertyDetails,
        metadata: cleanedMetadata,
        timestamp: Firestore.FieldValue.serverTimestamp(),
      };

      // Store the data
      await docRef.set(
        {
          fileName,
          processed: processedData,
          status: "processed",
          lastUpdated: Firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log(
        `[${new Date().toISOString()}] 📝 Stored processed analysis in Firestore for ${fileName}`
      );
      return docRef.id;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error storing processed analysis in Firestore:`,
        error.message
      );
      throw error;
    }
  }

  async getProcessedAnalysis(fileName) {
    try {
      // If Firestore is not initialized, return null
      if (!this.isInitialized) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Firestore not initialized, cannot retrieve data`
        );
        return null;
      }

      const docRef = this.db
        .collection(this.videoAnalysisCollection)
        .doc(fileName);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      return doc.data();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Error retrieving processed analysis from Firestore:`,
        error.message
      );
      return null;
    }
  }
}

module.exports = new FirestoreService();
