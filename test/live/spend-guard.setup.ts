if (process.env.INTEGRATION_TEST_ON === "1" && process.env.DIFFWARDEN_ALLOW_MODEL_SPEND !== "1") {
  throw new Error(
    "Live tests may spend model credits. Set DIFFWARDEN_ALLOW_MODEL_SPEND=1 to run them.",
  );
}
