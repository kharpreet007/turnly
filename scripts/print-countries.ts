// Prints the COUNTRIES table for landing/index.html from the backend rules (single source of truth).
import { CALLING_CODES } from '@turnly/core';
console.log(JSON.stringify(CALLING_CODES.map((c) => [c.cc, c.name, c.min, c.max, c.leading ? c.leading.source : ''])));
