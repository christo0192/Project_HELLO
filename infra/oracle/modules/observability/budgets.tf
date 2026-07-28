# No separate budget or budget alarm is created here.
# The foundation module owns the single authoritative compartment budget
# (oci_budget_budget + oci_budget_alert_rule) with percentage-based alerting.
# The oci_budget_alert_rule is the only cost alarm needed for this compartment.
