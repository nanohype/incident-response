{{- define "marshal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "marshal.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "marshal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "marshal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
agents.stxkxs.io/tenant: protohype
agents.stxkxs.io/platform: marshal
{{- end -}}

{{- define "marshal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "marshal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
marshal.io/service: {{ .service }}
{{- end -}}

{{- define "marshal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "marshal.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "marshal.env" -}}
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
