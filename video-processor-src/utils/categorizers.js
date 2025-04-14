const { KEYWORDS } = require("../config/constants");

// Categorize objects into furniture, appliances, fixtures, and other
function categorizeObjects(objectSummary) {
  const categorizedObjects = {
    furniture: [],
    appliances: [],
    fixtures: [],
    other: [],
  };

  Object.entries(objectSummary).forEach(([object, data]) => {
    const objectLower = object.toLowerCase();
    if (KEYWORDS.FURNITURE.some((keyword) => objectLower.includes(keyword))) {
      categorizedObjects.furniture.push({ name: object, ...data });
    } else if (
      KEYWORDS.APPLIANCES.some((keyword) => objectLower.includes(keyword))
    ) {
      categorizedObjects.appliances.push({ name: object, ...data });
    } else if (
      KEYWORDS.FIXTURES.some((keyword) => objectLower.includes(keyword))
    ) {
      categorizedObjects.fixtures.push({ name: object, ...data });
    } else {
      categorizedObjects.other.push({ name: object, ...data });
    }
  });

  return categorizedObjects;
}

// Categorize labels into rooms, styles, materials, and other
function categorizeLabels(detectedLabels) {
  const categorizedLabels = {
    rooms: [],
    styles: [],
    materials: [],
    features: [],
    other: [],
  };

  detectedLabels.forEach((label) => {
    const labelLower = label.description.toLowerCase();
    if (KEYWORDS.ROOMS.some((keyword) => labelLower.includes(keyword))) {
      categorizedLabels.rooms.push({
        name: label.description,
        confidence: label.confidence,
      });
    } else if (
      KEYWORDS.STYLES.some((keyword) => labelLower.includes(keyword))
    ) {
      categorizedLabels.styles.push({
        name: label.description,
        confidence: label.confidence,
      });
    } else if (
      KEYWORDS.MATERIALS.some((keyword) => labelLower.includes(keyword))
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

  return categorizedLabels;
}

// Categorize text into property details, prices, and other
function categorizeText(detectedText) {
  const categorizedText = {
    propertyDetails: [],
    prices: [],
    other: [],
  };

  detectedText.forEach((text) => {
    const textLower = text.text.toLowerCase();
    if (textLower.includes("$") || /\d+/.test(text.text)) {
      categorizedText.prices.push({
        text: text.text,
        confidence: text.confidence,
      });
    } else if (
      textLower.includes("bedroom") ||
      textLower.includes("bathroom") ||
      textLower.includes("square") ||
      textLower.includes("foot") ||
      textLower.includes("year") ||
      textLower.includes("built")
    ) {
      categorizedText.propertyDetails.push({
        text: text.text,
        confidence: text.confidence,
      });
    } else {
      categorizedText.other.push({
        text: text.text,
        confidence: text.confidence,
      });
    }
  });

  return categorizedText;
}

module.exports = {
  categorizeObjects,
  categorizeLabels,
  categorizeText,
};
