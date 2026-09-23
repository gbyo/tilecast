import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { canManageContent } from "./ContentPage";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
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
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../components/ui/questionnaire";
import { Spinner } from "../components/ui/spinner";

type CreateQuestionName =
  "name" | "description" | "formTitle" | "formDescription";

type CreateQuestion = {
  name: CreateQuestionName;
  phaseKey: "create.phasePurpose" | "create.phaseDisplay";
  titleKey: `create.questions.${CreateQuestionName}.title`;
  descriptionKey: `create.questions.${CreateQuestionName}.description`;
  labelKey: `create.questions.${CreateQuestionName}.label`;
  autoComplete: string;
};

const QUESTIONS: CreateQuestion[] = [
  {
    name: "name",
    phaseKey: "create.phasePurpose",
    titleKey: "create.questions.name.title",
    descriptionKey: "create.questions.name.description",
    labelKey: "create.questions.name.label",
    autoComplete: "off",
  },
  {
    name: "description",
    phaseKey: "create.phasePurpose",
    titleKey: "create.questions.description.title",
    descriptionKey: "create.questions.description.description",
    labelKey: "create.questions.description.label",
    autoComplete: "off",
  },
  {
    name: "formTitle",
    phaseKey: "create.phaseDisplay",
    titleKey: "create.questions.formTitle.title",
    descriptionKey: "create.questions.formTitle.description",
    labelKey: "create.questions.formTitle.label",
    autoComplete: "off",
  },
  {
    name: "formDescription",
    phaseKey: "create.phaseDisplay",
    titleKey: "create.questions.formDescription.title",
    descriptionKey: "create.questions.formDescription.description",
    labelKey: "create.questions.formDescription.label",
    autoComplete: "off",
  },
];

const EMPTY = { name: "", description: "", formTitle: "", formDescription: "" };

// CreateFormDataSourcePage guides creation through purpose and display
// questions, then a review step, before creating the Form (which the server
// publishes as its first revision) and navigating to the new form's builder.
// Only the create endpoint's own fields are asked here: who may submit and
// the review rules are configured in the builder's Access and Workflow tabs
// after creation, so the guided flow never collects answers it cannot send.
export function CreateFormDataSourcePage() {
  const { t } = useTranslation(["forms", "common"]);
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [item, setItem] = useState<CreateQuestion["name"]>(QUESTIONS[0]!.name);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [review, setReview] = useState<typeof EMPTY | null>(null);
  const [error, setError] = useState("");

  const index = Math.max(
    0,
    QUESTIONS.findIndex((question) => question.name === item),
  );
  const current: CreateQuestion = QUESTIONS[index] ?? QUESTIONS[0]!;

  const create = useMutation({
    mutationFn: (values: typeof EMPTY) =>
      api.createForm(
        {
          name: values.name.trim(),
          description: values.description.trim(),
          draftSchema: {
            title: values.formTitle.trim(),
            description: values.formDescription.trim(),
            fields: [
              {
                key: "title",
                label: t("create.starterFieldLabel"),
                control: "short_text",
                required: true,
              },
            ],
          },
        },
        csrf,
      ),
    onMutate: () => setError(""),
    onSuccess: (form) => {
      void queryClient.invalidateQueries({ queryKey: ["forms"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      void navigate(`/plugins/forms/${form.id}?tab=form`);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : t("create.createFallback")),
  });

  const changeItem = (next: string) => {
    const target = QUESTIONS.find((question) => question.name === next);
    if (!target) return;
    const nextIndex = QUESTIONS.indexOf(target);
    if (nextIndex > index && current.name === "name") {
      if ((answers.name ?? "").trim() === "") {
        setErrors((previous) => ({
          ...previous,
          name: t("create.nameRequired"),
        }));
        return;
      }
      setErrors((previous) => ({ ...previous, name: "" }));
    }
    setItem(target.name);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values: typeof EMPTY = { ...EMPTY, ...answers };
    if (values.name.trim() === "") {
      setErrors((previous) => ({
        ...previous,
        name: t("create.nameRequired"),
      }));
      setItem("name");
      return;
    }
    setReview(values);
  };

  if (!canManageContent(auth.status?.user)) {
    return (
      <section className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6">
        <Alert variant="destructive">
          <AlertTitle>{t("create.deniedTitle")}</AlertTitle>
          <AlertDescription>{t("create.deniedBody")}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (review) {
    return (
      <section
        aria-labelledby="create-form-review-title"
        className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6"
      >
        <header className="grid gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("create.reviewEyebrow")}
          </p>
          <h1
            id="create-form-review-title"
            className="text-xl font-semibold tracking-tight"
          >
            {t("create.reviewTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("create.reviewBody")}
          </p>
        </header>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t("create.createErrorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <dl className="grid gap-3 rounded-xl border border-border bg-card p-4 text-sm sm:p-5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t("create.summaryName")}</dt>
            <dd className="font-medium">{review.name}</dd>
          </div>
          {review.description && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">
                {t("create.summaryPurpose")}
              </dt>
              <dd className="font-medium">{review.description}</dd>
            </div>
          )}
          {review.formTitle && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">
                {t("create.summarySubmitterTitle")}
              </dt>
              <dd className="font-medium">{review.formTitle}</dd>
            </div>
          )}
          {review.formDescription && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">
                {t("create.summaryGuidance")}
              </dt>
              <dd className="font-medium">{review.formDescription}</dd>
            </div>
          )}
        </dl>
        <Alert>
          <AlertTitle>{t("create.starterTitle")}</AlertTitle>
          <AlertDescription>
            {t("create.starterBody", {
              starterLabel: t("create.starterFieldLabel"),
            })}
          </AlertDescription>
        </Alert>
        <FieldGroup>
          <Field>
            <Button
              type="button"
              disabled={create.isPending}
              onClick={() => create.mutate(review)}
            >
              {create.isPending && <Spinner aria-hidden="true" />}
              {t("create.createButton")}
            </Button>
          </Field>
          <Field>
            <Button
              type="button"
              variant="ghost"
              disabled={create.isPending}
              onClick={() => setReview(null)}
            >
              {t("create.backToQuestions")}
            </Button>
            <FieldDescription className="text-center">
              {t("create.backHint")}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("create.stepHeader", {
            step: index < 2 ? 1 : 2,
            phase: t(current.phaseKey),
          })}
        </p>
        <h1 className="text-xl font-semibold tracking-tight">
          {t("create.createTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("create.createSubtitle")}
        </p>
      </header>
      <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <Questionnaire
          items={QUESTIONS.map((question) => ({
            name: question.name,
            required: question.name === "name",
          }))}
          item={item}
          onItemChange={changeItem}
          onSubmit={submit}
          noValidate
        >
          <QuestionnaireProgress>
            {t("create.progress", {
              index: index + 1,
              total: QUESTIONS.length,
            })}
          </QuestionnaireProgress>
          {QUESTIONS.map((question) => (
            <QuestionnaireItem
              key={question.name}
              name={question.name}
              required={question.name === "name"}
              invalid={Boolean(errors[question.name])}
            >
              <QuestionnaireTitle>{t(question.titleKey)}</QuestionnaireTitle>
              <QuestionnaireDescription>
                {t(question.descriptionKey)}
              </QuestionnaireDescription>
              <QuestionnaireInput
                aria-label={t(question.labelKey)}
                autoComplete={question.autoComplete}
                value={answers[question.name] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setAnswers((previous) => ({
                    ...previous,
                    [question.name]: value,
                  }));
                  setErrors((previous) => ({
                    ...previous,
                    [question.name]: "",
                  }));
                }}
              />
              <QuestionnaireError>{errors[question.name]}</QuestionnaireError>
            </QuestionnaireItem>
          ))}
          <QuestionnaireActions>
            <QuestionnairePrevious>
              {t("create.navPrevious")}
            </QuestionnairePrevious>
            {current.name !== "name" && (
              <QuestionnaireSkip>{t("create.navSkip")}</QuestionnaireSkip>
            )}
            <QuestionnaireNext>{t("create.navNext")}</QuestionnaireNext>
            <QuestionnaireSubmit>{t("create.navReview")}</QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
        <div className="flex justify-start">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void navigate("/plugins/forms")}
          >
            {t("common:actions.back")}
          </Button>
        </div>
      </div>
    </section>
  );
}
