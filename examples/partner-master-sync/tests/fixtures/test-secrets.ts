// Synthetic keys for the saved Bango signer fixtures only; never use in a real environment.
export const previousTestSecret = `whsec_${Buffer.alloc(32, 0x07).toString('base64')}`;
export const currentTestSecret = `whsec_${Buffer.alloc(32, 0x09).toString('base64')}`;
