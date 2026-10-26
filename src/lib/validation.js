import { z } from 'zod';
import { CATEGORIES, CONDITIONS, COUNTRIES, GAMES, LANGUAGES, ORDER_STATUSES, SHIPPING_METHODS } from './catalog.js';

const text = (max, min = 1) => z.string().trim().min(min).max(max);
const keys = (obj) => Object.keys(obj);

export const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email());
const passwordField = z.string().min(10, 'Le mot de passe doit faire au moins 10 caractères').max(128);

export const addressShape = {
  firstName: text(60),
  lastName: text(60),
  phone: z.string().trim().regex(/^[+0-9 ().-]{6,20}$/),
  addressLine1: text(120, 3),
  addressLine2: text(120, 0).optional().default(''),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/),
  city: text(80),
  country: z.enum(keys(COUNTRIES)),
};

export const registerSchema = z
  .object({
    email: emailField,
    password: passwordField,
    passwordConfirm: z.string(),
    ...addressShape,
    acceptTerms: z.literal('on'),
  })
  .refine((d) => d.password === d.passwordConfirm, { path: ['passwordConfirm'], message: 'Les mots de passe ne correspondent pas' });

export const loginSchema = z.object({ email: emailField, password: z.string().min(1).max(128) });

export const guestLoginSchema = z.object({
  reference: z.string().trim().min(4).max(20),
  code: z.string().trim().min(4).max(30),
});

export const profileSchema = z.object(addressShape);

export const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordField, newPasswordConfirm: z.string() })
  .refine((d) => d.newPassword === d.newPasswordConfirm, { path: ['newPasswordConfirm'], message: 'Les mots de passe ne correspondent pas' });

export const checkoutSchema = z.object({
  email: emailField,
  ...addressShape,
  shippingMethod: z.enum(keys(SHIPPING_METHODS)),
  promoCode: z.string().trim().max(30).optional().default(''),
  note: z.string().trim().max(500).optional().default(''),
  acceptTerms: z.union([z.literal('on'), z.literal(true)]),
});

export const quoteSchema = z.object({
  shippingMethod: z.enum(keys(SHIPPING_METHODS)).catch('colissimo'),
  promoCode: z.string().trim().max(30).optional().default(''),
});

export const cartUpdateSchema = z.object({
  productId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(0).max(99),
});

const priceBound = z
  .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().min(0).max(1_000_000).optional())
  .catch(undefined);

export const shopQuerySchema = z.object({
  q: z.string().trim().max(80).catch(''),
  game: z.enum(keys(GAMES)).optional().catch(undefined),
  category: z.enum(keys(CATEGORIES)).optional().catch(undefined),
  condition: z.enum(keys(CONDITIONS)).optional().catch(undefined),
  // An empty field means "no bound": z.coerce.number('') would otherwise give 0 (and "max 0 €" hides everything).
  minPrice: priceBound,
  maxPrice: priceBound,
  inStock: z.literal('1').optional().catch(undefined),
  set: z.string().trim().max(120).optional().catch(undefined).transform((v) => v || undefined),
  lang: z.enum(keys(LANGUAGES)).optional().catch(undefined),
  grader: z.string().trim().toUpperCase().regex(/^[A-Z]{2,12}$/).optional().catch(undefined),
  sort: z.enum(['relevance', 'new', 'price_asc', 'price_desc', 'name']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

const checkbox = z.preprocess((v) => v === 'on' || v === '1' || v === true, z.boolean());

export const productSchema = z.object({
  name: text(120),
  game: z.enum(keys(GAMES)),
  category: z.enum(keys(CATEGORIES)),
  setName: text(120, 0).optional().default(''),
  cardNumber: text(30, 0).optional().default(''),
  rarity: text(60, 0).optional().default(''),
  condition: z.enum(keys(CONDITIONS)),
  language: z.enum(keys(LANGUAGES)),
  grading: text(40, 0).optional().default(''),
  description: text(4000, 0).optional().default(''),
  price: z.coerce.number().positive().max(1_000_000),
  stock: z.coerce.number().int().min(0).max(100_000),
  isFeatured: checkbox,
  active: checkbox,
});

export const orderStatusSchema = z.object({
  status: z.enum(keys(ORDER_STATUSES)),
  trackingNumber: text(60, 0).optional().default(''),
  note: text(300, 0).optional().default(''),
});

export const promoSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
  percentOff: z.coerce.number().int().min(1).max(90),
  maxUses: z.union([z.literal(''), z.coerce.number().int().min(1).max(1_000_000)]).optional(),
  expiresAt: z.union([z.literal(''), z.iso.date()]).optional(),
});

export const stockAlertSchema = z.object({ email: emailField });

const FIELD_LABELS = {
  email: 'E-mail', password: 'Mot de passe', passwordConfirm: 'Confirmation du mot de passe',
  firstName: 'Prénom', lastName: 'Nom', phone: 'Téléphone', addressLine1: 'Adresse', addressLine2: 'Complément d’adresse',
  postalCode: 'Code postal', city: 'Ville', country: 'Pays', acceptTerms: 'Conditions générales de vente',
  shippingMethod: 'Mode de livraison', currentPassword: 'Mot de passe actuel', newPassword: 'Nouveau mot de passe',
  newPasswordConfirm: 'Confirmation', reference: 'Référence', code: 'Numéro de commande', price: 'Prix', stock: 'Stock',
  name: 'Nom', note: 'Note',
};

export function formatIssues(error) {
  const seen = new Set();
  const messages = [];
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '');
    if (seen.has(field)) continue;
    seen.add(field);
    const label = FIELD_LABELS[field] || field || 'Formulaire';
    const custom = issue.message && !issue.message.startsWith('Invalid') && !issue.message.startsWith('Too');
    messages.push(custom ? `${label} : ${issue.message}` : `${label} : valeur invalide`);
  }
  return messages;
}
