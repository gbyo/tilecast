import type { TFunction } from "i18next";
import { z } from "zod";

// Schemas are built at render time from `t` so validation messages follow
// the interface language. Callers pass the `t` they already use.
export function makeSetupSchema(t: TFunction<"auth">) {
  return z
    .object({
      organizationName: z
        .string()
        .trim()
        .min(2, t("validation.organizationName"))
        .max(120),
      ownerName: z.string().trim().min(2, t("validation.ownerName")).max(120),
      username: z
        .string()
        .trim()
        .min(3, t("validation.usernameMin"))
        .max(254)
        .regex(/^[a-zA-Z0-9._@+-]+$/, t("validation.usernameChars")),
      password: z.string().min(12, t("validation.passwordMin")).max(1024),
      confirmPassword: z.string(),
    })
    .refine((value) => value.password === value.confirmPassword, {
      message: t("validation.passwordsMatch"),
      path: ["confirmPassword"],
    });
}

export function makeLoginSchema(t: TFunction<"auth">) {
  return z.object({
    username: z.string().trim().min(1, t("validation.loginUsername")),
    password: z.string().min(1, t("validation.loginPassword")),
  });
}

// A recovery code is entered in the same box as an authenticator code, so the
// field accepts both shapes and the server decides which one it is.
export function makeMfaSchema(t: TFunction<"auth">) {
  return z.object({
    code: z.string().trim().min(6, t("validation.mfaCode")),
  });
}

export type SetupForm = z.infer<ReturnType<typeof makeSetupSchema>>;
export type LoginForm = z.infer<ReturnType<typeof makeLoginSchema>>;
export type MFAForm = z.infer<ReturnType<typeof makeMfaSchema>>;
