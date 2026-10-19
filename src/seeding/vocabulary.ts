export const MODULES = [
  'checkout',
  'auth',
  'profile',
  'settings',
  'cart',
  'search',
  'orders',
  'notifications',
  'onboarding',
  'dashboard',
] as const;

export const SECTIONS = [
  'button',
  'label',
  'title',
  'message',
  'error',
  'hint',
  'placeholder',
  'tooltip',
] as const;

const words = (list: string): readonly string[] => list.split(' ');

const WORDS: Readonly<Record<string, readonly string[]>> = {
  en: words(
    'save cancel continue pay now your account order settings profile password email address ' +
      'payment shipping confirm delete update search results welcome back please try again later',
  ),
  fr: words(
    'enregistrer annuler continuer payer maintenant votre compte commande paramètres profil mot ' +
      'de passe adresse paiement livraison confirmer supprimer mettre à jour rechercher bienvenue',
  ),
  es: words(
    'guardar cancelar continuar pagar ahora tu cuenta pedido ajustes perfil contraseña correo ' +
      'dirección pago envío confirmar eliminar actualizar buscar resultados bienvenido inténtalo',
  ),
  de: words(
    'speichern abbrechen weiter bezahlen jetzt ihr konto bestellung einstellungen profil passwort ' +
      'e-mail adresse zahlung versand bestätigen löschen aktualisieren suchen ergebnisse später',
  ),
};

export const LOCALE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
};

/** Falls back to English words for locales without a dedicated vocabulary. */
export function wordsFor(locale: string): readonly string[] {
  return WORDS[locale] ?? WORDS.en ?? [];
}
