"use client";

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import styles from "./page.module.css";

type FormValues = {
  registrationNumber: string;
  invoiceDate: string;
  amount: string;
  memo: string;
};

type InvoiceValidity = {
  registrationNumber: string;
  date: string;
  valid: boolean;
  registrationDate: string | null;
  cancelDate: string | null;
  expireDate: string | null;
};

type ApiError = {
  code?: string;
  error?: string;
};

type CheckStatus =
  | "idle"
  | "checking"
  | "valid"
  | "invalid"
  | "not_found"
  | "error";

export default function Home() {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    mode: "onBlur",
    defaultValues: {
      registrationNumber: "",
      invoiceDate: "",
      amount: "",
      memo: "",
    },
  });

  const [checkStatus, setCheckStatus] =
    useState<CheckStatus>("idle");
  const [validity, setValidity] =
    useState<InvoiceValidity | null>(null);
  const [checkError, setCheckError] =
    useState<string | null>(null);

  const requestControllerRef =
    useRef<AbortController | null>(null);

  function clearValidityCheck() {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;

    setCheckStatus("idle");
    setValidity(null);
    setCheckError(null);
  }

  async function checkRegistrationNumber(
    registrationNumber: string,
  ) {
    const normalized = registrationNumber.trim();

    if (!/^T\d{13}$/.test(normalized)) {
      return;
    }

    requestControllerRef.current?.abort();

    const controller = new AbortController();
    requestControllerRef.current = controller;

    setCheckStatus("checking");
    setValidity(null);
    setCheckError(null);

    try {
      const response = await fetch(
        `/api/invoice-valid/${encodeURIComponent(normalized)}`,
        {
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = (await response
          .json()
          .catch(() => ({}))) as ApiError;

        setValidity(null);

        if (response.status === 404) {
          setCheckStatus("not_found");
          return;
        }

        setCheckStatus("error");
        setCheckError(
          body.error ??
            "現在確認できません。時間を置いて再試行してください",
        );

        return;
      }

      const result =
        (await response.json()) as InvoiceValidity;

      setValidity(result);
      setCheckStatus(
        result.valid ? "valid" : "invalid",
      );
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }

      setValidity(null);
      setCheckStatus("error");
      setCheckError(
        "現在確認できません。時間を置いて再試行してください",
      );
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }

  const registrationNumberField = register(
    "registrationNumber",
    {
      required: "T番号を入力してください",
      pattern: {
        value: /^T\d{13}$/,
        message:
          "T番号はT + 13桁の数字で入力してください",
      },
    },
  );

  function onSubmit(values: FormValues) {
    console.log(values);
  }

  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>請求書登録</p>
          <h1>請求書を登録</h1>
          <p>
            T番号を入力すると、現在のインボイス登録状況を
            自動で確認します。
          </p>
        </header>

        <form
          className={styles.form}
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className={styles.field}>
            <label htmlFor="registrationNumber">
              インボイス登録番号
            </label>

            <input
              id="registrationNumber"
              type="text"
              placeholder="T1180301018771"
              autoComplete="off"
              spellCheck={false}
              {...registrationNumberField}
              onChange={(event) => {
                registrationNumberField.onChange(event);
                clearValidityCheck();
              }}
              onBlur={(event) => {
                registrationNumberField.onBlur(event);
                void checkRegistrationNumber(
                  event.target.value,
                );
              }}
            />

            <p className={styles.helper}>
              入力後にフォーカスを外すと、
              現在の登録状況を確認します。
            </p>

            {errors.registrationNumber && (
              <p className={styles.validationError}>
                {errors.registrationNumber.message}
              </p>
            )}

            <div
              className={styles.validityArea}
              aria-live="polite"
            >
              {checkStatus === "checking" && (
                <p>登録状況を確認しています...</p>
              )}

              {checkStatus === "valid" && validity && (
                <div className={styles.validResult}>
                  <strong>
                    ✓ 現在有効な登録番号です
                  </strong>
                  <span>
                    判定基準日: {validity.date}
                  </span>
                  <span>
                    登録日:{" "}
                    {validity.registrationDate ?? "—"}
                  </span>
                </div>
              )}

              {checkStatus === "invalid" && validity && (
                <div className={styles.invalidResult}>
                  <strong>
                    現在は有効ではありません
                  </strong>

                  <span>
                    判定基準日: {validity.date}
                  </span>

                  {validity.registrationDate && (
                    <span>
                      登録日: {validity.registrationDate}
                    </span>
                  )}

                  {validity.cancelDate && (
                    <span>
                      取消日: {validity.cancelDate}
                    </span>
                  )}

                  {validity.expireDate && (
                    <span>
                      失効日: {validity.expireDate}
                    </span>
                  )}
                </div>
              )}

              {checkStatus === "not_found" && (
                <p className={styles.checkError}>
                  登録番号が見つかりませんでした
                </p>
              )}

              {checkStatus === "error" && (
                <p className={styles.checkError}>
                  {checkError}
                </p>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label htmlFor="invoiceDate">
              請求日
            </label>

            <input
              id="invoiceDate"
              type="date"
              {...register("invoiceDate", {
                required: "請求日を入力してください",
              })}
            />

            {errors.invoiceDate && (
              <p className={styles.validationError}>
                {errors.invoiceDate.message}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor="amount">
              金額
            </label>

            <input
              id="amount"
              type="number"
              min="1"
              placeholder="110000"
              {...register("amount", {
                required: "金額を入力してください",
              })}
            />

            {errors.amount && (
              <p className={styles.validationError}>
                {errors.amount.message}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor="memo">
              メモ
              <span className={styles.optional}>
                任意
              </span>
            </label>

            <textarea
              id="memo"
              rows={4}
              {...register("memo")}
            />
          </div>

          <button
            type="submit"
            className={styles.submitButton}
          >
            請求書を登録
          </button>
        </form>
      </section>
    </main>
  );
}