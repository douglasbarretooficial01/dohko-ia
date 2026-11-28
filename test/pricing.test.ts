import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/credits/config.js";
import {
  CREDIT_VALUE_BRL,
  DISCOUNT,
  floorTo90,
  LOVABLE_ANNUAL_MONTHS,
  LOVABLE_PRO_USD,
  LOVABLE_TOPUP_USD_PER_CREDIT,
  PLANS,
  REFERENCE_RATE,
  TOPUP_PRICE_BRL,
} from "../src/credits/plans.js";

describe("tabela de preços: 15% abaixo da Lovable em todas as frentes", () => {
  it("arredonda sempre para baixo até ,90", () => {
    expect(floorTo90(117.79)).toBeCloseTo(116.9, 2);
    expect(floorTo90(117.95)).toBeCloseTo(117.9, 2);
    expect(floorTo90(117.9)).toBeCloseTo(117.9, 2);
  });

  it("tem os 11 degraus da Lovable, mensal e anual", () => {
    for (const t of LOVABLE_PRO_USD) {
      expect(PLANS[`pro_${t.credits}`]).toMatchObject({ interval: "month", monthlyCredits: t.credits });
      expect(PLANS[`pro_${t.credits}_anual`]).toMatchObject({ interval: "year", monthlyCredits: t.credits });
    }
    expect(Object.values(PLANS).filter((p) => p.priceBRL > 0)).toHaveLength(22);
  });

  it("cada degrau mensal e anual custa no máximo 85% do preço da Lovable no câmbio de referência", () => {
    for (const t of LOVABLE_PRO_USD) {
      const lovMonthly = t.monthlyUSD * REFERENCE_RATE;
      const lovAnnual = lovMonthly * LOVABLE_ANNUAL_MONTHS;
      expect(PLANS[`pro_${t.credits}`].priceBRL).toBeLessThanOrEqual(lovMonthly * (1 - DISCOUNT));
      expect(PLANS[`pro_${t.credits}_anual`].priceBRL).toBeLessThanOrEqual(lovAnnual * (1 - DISCOUNT));
      // e não fica barato demais por erro de conta (desconto entre 15% e 16%)
      expect(PLANS[`pro_${t.credits}`].priceBRL).toBeGreaterThan(lovMonthly * 0.84);
    }
  });

  it("recarga avulsa e crédito de referência também 15% abaixo", () => {
    expect(TOPUP_PRICE_BRL).toBeLessThanOrEqual(LOVABLE_TOPUP_USD_PER_CREDIT * REFERENCE_RATE * (1 - DISCOUNT));
    expect(CREDIT_VALUE_BRL).toBeLessThanOrEqual((25 / 100) * REFERENCE_RATE * (1 - DISCOUNT));
    expect(CONFIG.creditValueBRL).toBe(CREDIT_VALUE_BRL);
  });

  it("valores para conferência rápida", () => {
    expect(PLANS.pro_100.priceBRL).toBe(116.9);
    expect(PLANS.pro_100_anual.priceBRL).toBe(1176.9);
    expect(PLANS.pro_10000.priceBRL).toBe(10600.9);
    expect(TOPUP_PRICE_BRL).toBe(1.41);
  });
});
