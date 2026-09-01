"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import styles from "./page.module.css";

type FormValues = {
  registrationNumber: string;
};

type InvoiceIssuer = {
  kind: "corporation" | "individual";
  registrationNumber: string;
  registrationDate: string | null;
  valid: boolean;
  corporateNumber: string | null;
  name: string | null;
  postalCode: string | null;
  address: string | null;
};

type ApiError = {
  error?: string;
};

function getInvoiceStatus(valid: boolean): "有効" | "無効" {
  return valid ? "有効" : "無効";
}

export default function Home() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: {
      registrationNumber: "",
    },
  });

  const [issuer, setIssuer] = useState<InvoiceIssuer | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  async function onSubmit(values: FormValues) {
    setIssuer(null);
    setApiError(null);

    try {
      const response = await fetch(
        `/api/invoice/${encodeURIComponent(values.registrationNumber)}`,
      );

      if (!response.ok) {
        const body = (await response.json()) as ApiError;

        setApiError(
          body.error ?? "事業者情報の取得に失敗しました",
        );

        return;
      }

      const body = (await response.json()) as InvoiceIssuer;
      setIssuer(body);
    } catch {
      setApiError("事業者情報の取得に失敗しました");
    }
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          インボイス登録事業者を検索
        </h1>

        <p className={styles.description}>
          T番号を入力すると、登録事業者の情報を取得できます。
        </p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className={styles.form}
      >
        <label
          htmlFor="registrationNumber"
          className={styles.label}
        >
          インボイス登録番号
        </label>

        <input
          id="registrationNumber"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="T1180301018771"
          className={styles.input}
          {...register("registrationNumber", {
            required: "T番号を入力してください",
            pattern: {
              value: /^T\d{13}$/,
              message: "T番号はT + 13桁の数字で入力してください",
            },
            onChange: () => {
              setIssuer(null);
              setApiError(null);
            },
          })}
        />

        {errors.registrationNumber && (
          <p className={styles.validationError}>
            {errors.registrationNumber.message}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className={styles.submitButton}
        >
          {isSubmitting ? "取得中..." : "事業者情報を取得"}
        </button>
      </form>

      {apiError && (
        <div
          role="alert"
          className={styles.apiError}
        >
          {apiError}
        </div>
      )}

      {issuer && (
        <section className={styles.result}>
          <h2 className={styles.resultTitle}>
            事業者情報
          </h2>

          <dl className={styles.details}>
            <dt>事業者種別</dt>
            <dd>
              {issuer.kind === "corporation"
                ? "法人"
                : "個人事業者"}
            </dd>

            {issuer.kind === "corporation" && (
              <>
                <dt>事業者名</dt>
                <dd>{issuer.name ?? "—"}</dd>

                <dt>法人番号</dt>
                <dd>{issuer.corporateNumber ?? "—"}</dd>

                <dt>所在地</dt>
                <dd className={styles.address}>
                  {issuer.postalCode && (
                    <span>〒{issuer.postalCode}</span>
                  )}
                  <span>{issuer.address ?? "—"}</span>
                </dd>
              </>
            )}

            <dt>T番号</dt>
            <dd>{issuer.registrationNumber}</dd>

            <dt>登録日</dt>
            <dd>{issuer.registrationDate ?? "—"}</dd>

            <dt>登録状態</dt>
            <dd>
              <span
                className={`${styles.statusBadge} ${
                  issuer.valid
                    ? styles.statusValid
                    : styles.statusInvalid
                }`}
              >
                {getInvoiceStatus(issuer.valid)}
              </span>
            </dd>
          </dl>

          {issuer.kind === "individual" && (
            <div className={styles.privacyNotice}>
              個人事業者の氏名・屋号・住所は、
              プライバシー保護のため公開していません。
            </div>
          )}
        </section>
      )}
    </main>
  );
}
