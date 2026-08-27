const sanitizeText = (input: string) => input.replace(/[,*/]/g, '').trim();

export default sanitizeText;
