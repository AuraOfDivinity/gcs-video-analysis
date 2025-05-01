// Types for video analysis results
const VideoAnalysisTypes = {
  Transcription: {
    text: String,
    confidence: Number,
    timestamp: Number,
  },
  Label: {
    description: String,
    confidence: Number,
    timestamp: Number,
  },
  Text: {
    text: String,
    confidence: Number,
    timestamp: Number,
  },
};

// Types for categorized data
const CategorizedDataTypes = {
  Labels: {
    rooms: Array,
    styles: Array,
    materials: Array,
    features: Array,
    other: Array,
  },
  Text: {
    propertyDetails: Array,
    prices: Array,
    other: Array,
  },
};

// Types for API requests
const ApiRequestTypes = {
  Transcription: {
    inputUri: String,
    features: Array,
    videoContext: Object,
  },
  LabelDetection: {
    inputUri: String,
    features: Array,
  },
  TextDetection: {
    inputUri: String,
    features: Array,
  },
};

module.exports = {
  VideoAnalysisTypes,
  CategorizedDataTypes,
  ApiRequestTypes,
};
