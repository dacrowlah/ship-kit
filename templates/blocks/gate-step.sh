echo "needs succeeded: $ALL_SUCCEEDED; status: ${STATUS:-none}; enforced: ${ENFORCED:-unknown}"
if [ "$ALL_SUCCEEDED" = "true" ] && { [ "$STATUS" = "pass" ] || [ "$STATUS" = "override" ]; }; then
  exit 0
fi
if [ "$ENFORCED" = "false" ]; then
  echo "::warning::This check is in shadow mode. It would have failed with status '${STATUS:-none}'."
  exit 0
fi
echo "::error::The check did not run to a pass (status '${STATUS:-none}'). An absent or incomplete run is not a pass. After a rebuttal or an override, re-run ALL jobs (gh run rerun <run-id>, without --failed): re-running only failed jobs re-reads this attempt's result."
exit 1
