{{/*
App-specific helpers. Name/fullname/labels/serviceAccountName come from the
shared tenant-chart-base library (charts/tenant-chart-base); only the
multi-service selector and the shared env block live here.
*/}}

{{/* Per-service selector — adds incident-response.io/service: <name> to
     distinguish webhook / processor workloads under the same chart release */}}
{{- define "incident-response.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tenant-chart-base.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
incident-response.io/service: {{ .service }}
{{- end -}}

{{- define "incident-response.env" -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
- name: INCIDENTS_TABLE_NAME
  value: {{ .Values.tenantInfra.incidentsTableName | quote }}
- name: AUDIT_TABLE_NAME
  value: {{ .Values.tenantInfra.auditTableName | quote }}
- name: INCIDENT_EVENTS_QUEUE_URL
  value: {{ .Values.tenantInfra.incidentEventsQueueUrl | quote }}
- name: NUDGE_EVENTS_QUEUE_URL
  value: {{ .Values.tenantInfra.nudgeEventsQueueUrl | quote }}
- name: NUDGE_EVENTS_QUEUE_ARN
  value: {{ .Values.tenantInfra.nudgeEventsQueueArn | quote }}
- name: SLA_CHECK_QUEUE_URL
  value: {{ .Values.tenantInfra.slaCheckQueueUrl | quote }}
- name: SCHEDULER_ROLE_ARN
  value: {{ .Values.tenantInfra.schedulerRoleArn | quote }}
- name: SCHEDULER_GROUP_NAME
  value: {{ .Values.tenantInfra.schedulerGroupName | quote }}
{{- end -}}
