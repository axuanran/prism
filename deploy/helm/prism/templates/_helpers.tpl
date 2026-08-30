{{- define "prism.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "prism.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "prism.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "prism.labels" -}}
app.kubernetes.io/name: {{ include "prism.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "prism.serviceAccountName" -}}
{{- default (include "prism.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}
