// API Configuration
const API_CONFIG = {
  LANGUAGE_CODE: "en-US",
  ENABLE_AUTOMATIC_PUNCTUATION: true,
};

// Feature Keywords
const KEYWORDS = {
  ROOMS: [
    "kitchen",
    "bedroom",
    "bathroom",
    "living room",
    "dining room",
    "garage",
    "basement",
  ],
  STYLES: [
    "modern",
    "traditional",
    "contemporary",
    "classic",
    "minimalist",
    "rustic",
  ],
  MATERIALS: [
    "wood",
    "marble",
    "granite",
    "stainless steel",
    "ceramic",
    "glass",
    "concrete",
  ],
};

// API Features
const API_FEATURES = {
  TRANSCRIPTION: ["SPEECH_TRANSCRIPTION"],
  LABEL_DETECTION: ["LABEL_DETECTION"],
  TEXT_DETECTION: ["TEXT_DETECTION"],
};

// Queue Configuration
const QUEUE_CONFIG = {
  MAX_SIZE: 10,
  PROCESSING_DELAY: 12000, // 12 seconds
};

module.exports = {
  API_CONFIG,
  KEYWORDS,
  API_FEATURES,
  QUEUE_CONFIG,
};
