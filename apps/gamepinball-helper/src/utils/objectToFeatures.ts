const objectToFeatures = (obj: Record<string, unknown>) =>
  Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

export default objectToFeatures;
