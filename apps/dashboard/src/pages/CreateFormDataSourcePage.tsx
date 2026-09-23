import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

type CreateQuestion = {
  name: "name" | "description" | "formTitle" | "formDescription";
  phase: "Purpose" | "Display";
  title: string;
  description: string;
  label: string;
  autoComplete: string;
};

const QUESTIONS: CreateQuestion[] = [
  {
    name: "name",
    phase: "Purpose",
    title: "What is this form for?",
    description:
      "The name shown in the Forms plugin and when selecting form output in Widgets.",
    label: "Form name",
    autoComplete: "off",
  },
  {
    name: "description",
    phase: "Purpose",
    title: "Describe the purpose",
    description:
      "Optional. A short note for other Studio authors about what this form collects.",
    label: "Form description",
    autoComplete: "off",
  },
  {
    name: "formTitle",
    phase: "Display",
    title: "What do submitters see first?",
    description:
      "Optional. The title shown above the form to the person filling it in.",
    label: "Submitter-facing title",
    autoComplete: "off",
  },
  {
    name: "formDescription",
    phase: "Display",
    title: "Add guidance for submitters",
    description:
      "Optional. Short instructions shown under the title on the form itself.",
    label: "Submitter-facing description",
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
                label: "Title",
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
      setError(
        err instanceof Error ? err.message : "Could not create the form.",
      ),
  });

  const changeItem = (next: string) => {
    const target = QUESTIONS.find((question) => question.name === next);
    if (!target) return;
    const nextIndex = QUESTIONS.indexOf(target);
    if (nextIndex > index && current.name === "name") {
      if ((answers.name ?? "").trim() === "") {
        setErrors((previous) => ({
          ...previous,
          name: "A name is required.",
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
      setErrors((previous) => ({ ...previous, name: "A name is required." }));
      setItem("name");
      return;
    }
    setReview(values);
  };

  if (!canManageContent(auth.status?.user)) {
    return (
      <section className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6">
        <Alert variant="destructive">
          <AlertTitle>Insufficient access</AlertTitle>
          <AlertDescription>
            You do not have permission to create forms.
          </AlertDescription>
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
            Forms plugin · Step 3 of 3 · Review
          </p>
          <h1
            id="create-form-review-title"
            className="text-xl font-semibold tracking-tight"
          >
            Review and create
          </h1>
          <p className="text-sm text-muted-foreground">
            Check the details before creating this form.
          </p>
        </header>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not create form</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <dl className="grid gap-3 rounded-xl border border-border bg-card p-4 text-sm sm:p-5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Form name</dt>
            <dd className="font-medium">{review.name}</dd>
          </div>
          {review.description && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Purpose</dt>
              <dd className="font-medium">{review.description}</dd>
            </div>
          )}
          {review.formTitle && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Submitter title</dt>
              <dd className="font-medium">{review.formTitle}</dd>
            </div>
          )}
          {review.formDescription && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Submitter guidance</dt>
              <dd className="font-medium">{review.formDescription}</dd>
            </div>
          )}
        </dl>
        <Alert>
          <AlertTitle>A starter field is included</AlertTitle>
          <AlertDescription>
            Your form starts with a required “Title” field and is published
            immediately. You can add fields and publish new revisions from the
            builder. Who may submit and the review rules are configured in the
            builder’s Access and Workflow tabs after creation.
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
              Create form
            </Button>
          </Field>
          <Field>
            <Button
              type="button"
              variant="ghost"
              disabled={create.isPending}
              onClick={() => setReview(null)}
            >
              Back to questions
            </Button>
            <FieldDescription className="text-center">
              Returns to guided creation without losing your answers.
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
          Forms plugin · Step {index < 2 ? 1 : 2} of 3 · {current.phase}
        </p>
        <h1 className="text-xl font-semibold tracking-tight">Create a Form</h1>
        <p className="text-sm text-muted-foreground">
          Collect submissions, approve them, and publish records to Widgets.
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
            Question {index + 1} of {QUESTIONS.length}
          </QuestionnaireProgress>
          {QUESTIONS.map((question) => (
            <QuestionnaireItem
              key={question.name}
              name={question.name}
              required={question.name === "name"}
              invalid={Boolean(errors[question.name])}
            >
              <QuestionnaireTitle>{question.title}</QuestionnaireTitle>
              <QuestionnaireDescription>
                {question.description}
              </QuestionnaireDescription>
              <QuestionnaireInput
                aria-label={question.label}
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
            <QuestionnairePrevious>Previous</QuestionnairePrevious>
            {current.name !== "name" && (
              <QuestionnaireSkip>Skip</QuestionnaireSkip>
            )}
            <QuestionnaireNext>Next</QuestionnaireNext>
            <QuestionnaireSubmit>Review</QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
        <div className="flex justify-start">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void navigate("/plugins/forms")}
          >
            Back
          </Button>
        </div>
      </div>
    </section>
  );
}
