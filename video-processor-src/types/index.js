// Types for video analysis results
const VideoAnalysisTypes = {
  Transcription: {
    text: String,
    confidence: Number,
    timestamp: Number,
  },
  Object: {
    description: String,
    confidence: Number,
    timestamp: Number,
    count: Number,
    occurrences: Array,
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
  Objects: {
    furniture: Array,
    appliances: Array,
    fixtures: Array,
    other: Array,
  },
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
  ObjectTracking: {
    inputUri: String,
    features: Array,
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
