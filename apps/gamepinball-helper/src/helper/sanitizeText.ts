const REGEXP = /[,*/]/g;

const sanitizeText = (input: string) => input.replace(REGEXP, '').trim();

export default sanitizeText;
