import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { makeSetupSchema } from "../auth/schemas";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldGroup } from "../components/ui/field";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../components/ui/questionnaire";

// Questions store locale keys, translated at render, so the guided text
// follows the interface language. The sign-in field labels are shared with
// the login form; every other string belongs to the setup flow.
const QUESTIONS = [
  {
    name: "organizationName",
    phaseKey: "setup.phases.organization",
    titleKey: "setup.questions.organizationName.title",
    descriptionKey: "setup.questions.organizationName.description",
    labelKey: "setup.questions.organizationName.label",
    type: "text",
    autoComplete: "organization",
  },
  {
    name: "ownerName",
    phaseKey: "setup.phases.ownerAccount",
    titleKey: "setup.questions.ownerName.title",
    descriptionKey: "setup.questions.ownerName.description",
    labelKey: "setup.questions.ownerName.label",
    type: "text",
    autoComplete: "name",
  },
  {
    name: "username",
    phaseKey: "setup.phases.ownerAccount",
    titleKey: "setup.questions.username.title",
    descriptionKey: "setup.questions.username.description",
    labelKey: "fields.username",
    type: "text",
    autoComplete: "username",
  },
  {
    name: "password",
    phaseKey: "setup.phases.ownerAccount",
    titleKey: "setup.questions.password.title",
    descriptionKey: "setup.questions.password.description",
    labelKey: "fields.password",
    type: "password",
    autoComplete: "new-password",
    hintKey: "setup.questions.password.hint",
  },
  {
    name: "confirmPassword",
    phaseKey: "setup.phases.ownerAccount",
    titleKey: "setup.questions.confirmPassword.title",
    descriptionKey: "setup.questions.confirmPassword.description",
    labelKey: "setup.questions.confirmPassword.label",
    type: "password",
    autoComplete: "new-password",
  },
] as const;

type SetupQuestion = (typeof QUESTIONS)[number];

const EMPTY = {
  organizationName: "",
  ownerName: "",
  username: "",
  password: "",
  confirmPassword: "",
};

function issuesFor(
  values: typeof EMPTY,
  t: TFunction<"auth">,
): Partial<Record<keyof typeof EMPTY, string>> {
  const parsed = makeSetupSchema(t).safeParse(values);
  if (parsed.success) return {};
  const messages: Partial<Record<keyof typeof EMPTY, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof typeof EMPTY | undefined;
    if (key && !(key in messages)) messages[key] = issue.message;
  }
  return messages;
}

/**
 * Guided first-install setup. Questionnaire owns the ordered questions, the
 * active item, answer state, progress, and navigation; this host owns
 * validation (the same setup schema as before), the review step, and
 * transport through `setup()`. Nothing about the request payload changed.
 */
export function SetupFlow() {
  const { setup, error, isSubmitting } = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const [item, setItem] = useState<SetupQuestion["name"]>(QUESTIONS[0].name);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [review, setReview] = useState<typeof EMPTY | null>(null);

  const index = Math.max(
    0,
    QUESTIONS.findIndex((question) => question.name === item),
  );
  const current: SetupQuestion = QUESTIONS[index] ?? QUESTIONS[0];

  const changeItem = (next: string) => {
    const target = QUESTIONS.find((question) => question.name === next);
    if (!target) return;
    const nextIndex = QUESTIONS.indexOf(target);
    if (nextIndex > index) {
      const message = issuesFor({ ...EMPTY, ...answers }, t)[current.name];
      if (message) {
        setErrors((previous) => ({ ...previous, [current.name]: message }));
        return;
      }
      setErrors((previous) => ({ ...previous, [current.name]: "" }));
    }
    setItem(target.name);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The inputs are controlled, so host state is the source of truth rather
    // than form data; the primitive names its own inputs after each item.
    const values: typeof EMPTY = { ...EMPTY, ...answers };
    const problems = issuesFor(values, t);
    const firstBad = QUESTIONS.find((question) => problems[question.name]);
    if (firstBad) {
      setAnswers({
        organizationName: values.organizationName,
        ownerName: values.ownerName,
        username: values.username,
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      setErrors(problems);
      setItem(firstBad.name);
      return;
    }
    setReview(values);
  };

  if (review) {
    return (
      <div aria-labelledby="setup-review-title">
        <header className="mb-6 text-center">
          <p className="text-xs font-medium text-muted-foreground">
            {t("setup.review.eyebrow")}
          </p>
          <h1
            id="setup-review-title"
            className="mt-1 text-xl font-semibold tracking-tight"
          >
            {t("setup.review.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("setup.review.description")}
          </p>
        </header>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <dl className="mb-6 grid gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">
              {t("setup.review.organizationLabel")}
            </dt>
            <dd className="font-medium">{review.organizationName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">
              {t("setup.review.ownerLabel")}
            </dt>
            <dd className="font-medium">{review.ownerName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">
              {t("setup.review.usernameLabel")}
            </dt>
            <dd className="font-medium">{review.username}</dd>
          </div>
        </dl>
        <FieldGroup>
          <Field>
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() =>
                void setup({
                  organizationName: review.organizationName,
                  ownerName: review.ownerName,
                  username: review.username,
                  password: review.password,
                })
              }
            >
              {isSubmitting
                ? t("setup.review.submitting")
                : t("setup.review.submit")}
            </Button>
            <FieldDescription className="text-center">
              {t("setup.review.passwordNote")}
            </FieldDescription>
          </Field>
          <Field>
            <Button
              type="button"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() => setReview(null)}
            >
              {t("setup.review.back")}
            </Button>
          </Field>
        </FieldGroup>
      </div>
    );
  }

  return (
    <div aria-labelledby="setup-title">
      <header className="mb-6 text-center">
        <p className="text-xs font-medium text-muted-foreground">
          {t("setup.stepOf", {
            step: index < 1 ? 1 : 2,
            phase: t(current.phaseKey),
          })}
        </p>
        <h1
          id="setup-title"
          className="mt-1 text-xl font-semibold tracking-tight"
        >
          {t("setup.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("setup.subtitle")}
        </p>
      </header>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <Questionnaire
        items={QUESTIONS.map((question) => ({
          name: question.name,
          required: true,
        }))}
        item={item}
        onItemChange={changeItem}
        onSubmit={submit}
        noValidate
      >
        <QuestionnaireProgress>
          {t("setup.progress", {
            current: index + 1,
            total: QUESTIONS.length,
          })}
        </QuestionnaireProgress>
        {QUESTIONS.map((question) => (
          <QuestionnaireItem
            key={question.name}
            name={question.name}
            required
            invalid={Boolean(errors[question.name])}
          >
            <QuestionnaireTitle>{t(question.titleKey)}</QuestionnaireTitle>
            <QuestionnaireDescription>
              {t(question.descriptionKey)}
              {"hintKey" in question && question.hintKey
                ? ` ${t(question.hintKey)}`
                : ""}
            </QuestionnaireDescription>
            <QuestionnaireInput
              aria-label={t(question.labelKey)}
              type={question.type}
              autoComplete={question.autoComplete}
              value={answers[question.name] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setAnswers((previous) => ({
                  ...previous,
                  [question.name]: value,
                }));
                setErrors((previous) => ({ ...previous, [question.name]: "" }));
              }}
            />
            <QuestionnaireError>{errors[question.name]}</QuestionnaireError>
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious disabled={isSubmitting}>
            {t("setup.previous")}
          </QuestionnairePrevious>
          <QuestionnaireNext disabled={isSubmitting}>
            {t("common:actions.next")}
          </QuestionnaireNext>
          <QuestionnaireSubmit disabled={isSubmitting}>
            {t("setup.reviewAction")}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
