// Aura — классификация полей форм и заполнение из профиля.
// Чистая логика без DOM — тестируется в node.

export const FIELD_TYPES = {
  EMAIL: 'email',
  PHONE: 'phone',
  AGE: 'age',
  BIRTHDATE: 'birthdate',
  CITY: 'city',
  ADDRESS: 'address',
  WEBSITE: 'website',
  OCCUPATION: 'occupation',
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  NAME: 'name',
  NOTES: 'notes',
  TEXT: 'text',
  UNKNOWN: 'unknown',
};

/** Классифицирует поле по имени/id/placeholder/aria-label. */
export function classifyField(rawLabel) {
  const s = String(rawLabel || '').toLowerCase().trim();
  if (!s) return FIELD_TYPES.UNKNOWN;

  if (/(e-?mail|почт|почта)/.test(s) && !/адрес/.test(s)) return FIELD_TYPES.EMAIL;
  if (/(телефон|phone|mobile|моб|tel)/.test(s)) return FIELD_TYPES.PHONE;
  if (/(год|возраст|возраст|age)/.test(s)) return FIELD_TYPES.AGE;
  if (/(рожденн|birth|дата рождения|date of birth)/.test(s)) return FIELD_TYPES.BIRTHDATE;
  if (/(город|town|city|населён)/.test(s)) return FIELD_TYPES.CITY;
  if (/(адрес|улица|ул\.|address)/.test(s)) return FIELD_TYPES.ADDRESS;
  if (/(сайт|site|website|url|homepage|веб)/.test(s)) return FIELD_TYPES.WEBSITE;
  if (/(должность|професс|occupation|job|work|работа)/.test(s)) return FIELD_TYPES.OCCUPATION;
  if (/(фамилия|surname|family name|last name|отчество)/.test(s)) return FIELD_TYPES.LAST_NAME;
  if (/(имя|first name|given name|firstname)/.test(s)) return FIELD_TYPES.FIRST_NAME;
  if (/(имя|name|имя пользователя|username|nick)/.test(s)) return FIELD_TYPES.NAME;
  if (/(bio|about|примечание|comment|сообщение|message|memo|о себе)/.test(s)) return FIELD_TYPES.NOTES;
  return FIELD_TYPES.TEXT;
}

/**
 * Возвращает ключ профиля (поле JSON) для типа поля.
 * null — поле не заполняется автоматически.
 */
export function profileKeyFor(fieldType) {
  switch (fieldType) {
    case FIELD_TYPES.EMAIL: return 'email';
    case FIELD_TYPES.PHONE: return 'phone';
    case FIELD_TYPES.AGE: return 'age';
    case FIELD_TYPES.FIRST_NAME: return 'first_name';
    case FIELD_TYPES.LAST_NAME: return 'last_name';
    case FIELD_TYPES.BIRTHDATE: return 'birthdate';
    case FIELD_TYPES.CITY: return 'city';
    case FIELD_TYPES.ADDRESS: return 'address';
    case FIELD_TYPES.WEBSITE: return 'website';
    case FIELD_TYPES.OCCUPATION: return 'occupation';
    case FIELD_TYPES.NAME: return 'name';
    case FIELD_TYPES.NOTES: return 'about';
    default: return null;
  }
}

/** Зеркальный ключ (first/last) → proфиль value. */
export function profileValueFor(profile, fieldType) {
  const key = profileKeyFor(fieldType);
  if (!key || !profile) return null;
  const v = profile[key];
  return v != null && String(v).trim() ? String(v).trim() : null;
}

/**
 * Проверяет, что поле ещё не заполнено и может его заполнять.
 * password/hidden/submit всегда «не заполняются».
 */
export function isFillable(field) {
  if (!field) return false;
  const type = String(field.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'button') return false;
  if (field.value && String(field.value).trim()) return false;
  return true;
}

/**
 * Полное состояние заполнения одного поля:
 * { type, needsProfile, needsAi, canFill }
 */
export function fieldPlan(field, profile) {
  const type = classifyField(field.label || field.name || field.placeholder || '');
  const needsProfile = isFillable(field) && profileValueFor(profile, type) != null;
  return {
    type,
    needsProfile,
    canFill: isFillable(field),
    needsAi: isFillable(field) && !needsProfile,
  };
}

/**
 * Извлекает значение профиля для поля (first/last → из имени или профиля).
 */
export function valueFor(field, profile) {
  const plan = fieldPlan(field, profile);
  if (!plan.canFill) return null;
  if (plan.needsProfile) {
    const type = plan.type;
    if (type === FIELD_TYPES.FIRST_NAME) return profile.first_name || profile.name || null;
    if (type === FIELD_TYPES.LAST_NAME) return profile.last_name || profile.name || null;
    if (type === FIELD_TYPES.NAME) return profile.name || null;
    return profileValueFor(profile, type);
  }
  return null; // требует решения модели
}
