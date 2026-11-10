/** CPF: só dígitos. */
export function soDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

/** 11 dígitos, não todos iguais e com os dois dígitos verificadores corretos. O banco confere de novo (public.cpf_valido). */
export function cpfValido(valor: string): boolean {
  const cpf = soDigitos(valor);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    if ((resto === 10 ? 0 : resto) !== Number(cpf[tamanho])) return false;
  }
  return true;
}

/** 123.456.789-09 */
export function formatarCpf(valor: string): string {
  const c = soDigitos(valor);
  return c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : valor;
}
