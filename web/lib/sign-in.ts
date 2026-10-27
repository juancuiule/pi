// The /login form's checks before it asks the server. Creating the first account checks the server's own name and
// password rules; signing in only checks that both fields are filled, so an account made under older rules can
// still sign in and a wrong guess reads as wrong credentials, not as a rule.
import { nameProblem, passwordProblem } from "effect-pi/api";

export type SignInMode = "setup" | "login";

export interface SignInForm {
  readonly name: string;
  readonly password: string;
  /** The password typed again; only creating an account asks for it. */
  readonly confirm: string;
}

export interface FormProblem {
  readonly field: keyof SignInForm;
  readonly message: string;
}

/** The first thing wrong with the form, top to bottom, or `undefined` when it can be sent. */
export const formProblem = (
  mode: SignInMode,
  form: SignInForm
): FormProblem | undefined => {
  if (mode === "login") {
    if (form.name === "") {
      return { field: "name", message: "Enter your name." };
    }
    return form.password === ""
      ? { field: "password", message: "Enter your password." }
      : undefined;
  }
  const name = nameProblem(form.name);
  if (name !== undefined) {
    return { field: "name", message: name };
  }
  const password = passwordProblem(form.password);
  if (password !== undefined) {
    return { field: "password", message: password };
  }
  return form.confirm === form.password
    ? undefined
    : { field: "confirm", message: "The passwords don't match." };
};
