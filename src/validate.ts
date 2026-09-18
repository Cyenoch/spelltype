import {
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  USERNAME_MAX_CHARS,
  USERNAME_MIN_CHARS,
} from '../shared/protocol';

const USERNAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_]+$/u;

export interface ValidationResult {
  ok: boolean;
  message: string;
}

const OK: ValidationResult = { ok: true, message: '' };

export function validateUsername(value: string): ValidationResult {
  const length = [...value].length;
  if (length === 0) return { ok: false, message: '请输入用户名。' };
  if (length < USERNAME_MIN_CHARS) {
    return { ok: false, message: `用户名至少 ${USERNAME_MIN_CHARS} 个字符。` };
  }
  if (length > USERNAME_MAX_CHARS) {
    return { ok: false, message: `用户名最多 ${USERNAME_MAX_CHARS} 个字符。` };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, message: '用户名只能包含中文、英文字母、数字和下划线。' };
  }
  return OK;
}

export function validatePassword(value: string): ValidationResult {
  const length = [...value].length;
  if (length === 0) return { ok: false, message: '请输入密码。' };
  if (length < PASSWORD_MIN_CHARS) {
    return { ok: false, message: `密码至少 ${PASSWORD_MIN_CHARS} 个字符。` };
  }
  if (length > PASSWORD_MAX_CHARS) {
    return { ok: false, message: `密码最多 ${PASSWORD_MAX_CHARS} 个字符。` };
  }
  return OK;
}
