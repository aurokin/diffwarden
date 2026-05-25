if (process.env.DIFFWARDEN_ALLOW_MODEL_SPEND !== "1") {
  console.error(
    "Live tests may spend model credits. Set DIFFWARDEN_ALLOW_MODEL_SPEND=1 to run them.",
  );
  process.exit(2);
}
