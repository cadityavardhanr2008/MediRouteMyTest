# Changelog

## 1.0.1 — assigned patient pickup visibility fix

- Removed the undefined `NO_SHIFT` reference from assigned emergency reconstruction.
- Confirmed that the authenticated crew snapshot retains the patient pickup address and exact coordinates.
- Draws ambulance and patient endpoint markers immediately, before the OSRM route request.
- Preserves the endpoint markers if road routing is unavailable and clearly warns that the dashed line is only a locator, not turn-by-turn navigation.
- Adds a one-click Google Maps directions fallback for the assigned pickup or selected hospital.
- Adds regression tests for crew pickup-coordinate delivery and marker-before-routing behaviour.
