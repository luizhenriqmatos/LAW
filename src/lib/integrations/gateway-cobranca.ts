/**
 * Porta para um futuro provedor de cobrança (Asaas, Mercado Pago ou similar). VAZIA de propósito:
 * o Prompt 7 não cobra ninguém. Quando houver provedor, os métodos (criar cobrança de uma parcela, consultar,
 * cancelar, receber confirmação de pagamento) entram aqui, e cada adaptador mora em /lib/integrations/<provedor>.ts.
 * Regras já definidas no CLAUDE.md: segredo só em variável de ambiente; nada de envio em massa; ação irreversível pede confirmação.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GatewayCobranca {}
