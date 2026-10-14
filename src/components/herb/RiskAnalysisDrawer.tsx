/**
 * RiskAnalysisDrawer 药材批次风险分析侧边抽屉
 * 功能：查看AI风险分析报告、触发AI重新分析、人工填写审核结论提交
 * 依赖 useBatchRiskAnalysis Hook 处理接口请求与TanStackQuery缓存
 * UI使用antd组件：抽屉、表单、时间线、标签、警告提示等
 * 业务逻辑：AI给出风险建议，管理员人工复核，最终保存审核结果
 */

import { useEffect } from 'react'
import {
    App as AntdApp,
    Alert,
    Button,
    Divider,
    Drawer,
    Empty,
    Form,
    Input,
    Select,
    Space,
    Spin,
    Tag,
    Timeline,
    Typography,
} from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useBatchRiskAnalysis } from '../../hooks/useBatchRiskAnalysis'
import { RISK_LABEL, type HerbBatch } from '../../types/herb'
import {
    RECOMMENDATION_LABEL,
    type RiskReviewInput,
} from '../../types/riskAnalysis'
import { AuditTag, RiskTag, StageTag } from './herbTags'
import { getRiskWorkbenchState, RISK_TOOL_LABEL, riskEvidenceLabel, riskProgressLabel } from '../../utils/riskWorkbench'
import './riskAnalysis.less'

const { Text, Title, Paragraph } = Typography



type Props = {
    batch: HerbBatch
    onClose: () => void
}

export default function RiskAnalysisDrawer({
    batch,
    onClose,
}: Props) {
    const { message } = AntdApp.useApp()
    const [form] = Form.useForm<RiskReviewInput>()
    const {
        query,
        analyze,
        review,
        progress,
        stopped,
        analysisError,
        startAnalyze,
        stopAnalyze,
    } = useBatchRiskAnalysis(batch.id)

    const analysis = query.data

    const operationError = analysisError ?? review.error

    useEffect(() => {
        // 包括“停止后重新查询到新建议”的情况，不能复用旧审核表单。
        if (analysis?.id) form.resetFields()
    }, [analysis?.id, form])

    const { canAnalyze, canReview, analyzeReason, reviewReason } = getRiskWorkbenchState({
        auditStatus: batch.auditStatus,
        analysis,
        analyzing: analyze.isPending,
        reviewing: review.isPending,
        reading: query.isPending || query.isFetching,
        readSuccess: query.isSuccess,
        readPaused: query.isPaused,
    })

    const handleClose = () => {
        // 人工审核是业务写入，提交期间不关闭，避免结果不明确。
        if (review.isPending) return

        // 先取消尚未完成的分析，再通知父组件卸载抽屉。
        stopAnalyze()
        onClose()
    }



    const handleAnalyze = async () => {
        if (!canAnalyze) return
        try {
            const result = await startAnalyze()

            if (result) {
                // 新建议不能继续使用上一份表单结论。
                form.resetFields()
            }
        } catch {
            // 主动取消由 stopped 提示，其他错误由 analysisError 展示。
        }
    }

    const fillSuggestion = () => {
        if (!analysis || !canReview) return

        form.setFieldsValue({
            // “人工复核”不替管理员选择通过还是驳回。
            decision:
                analysis.recommendation === 'approve'
                    ? 'approved'
                    : analysis.recommendation === 'reject'
                        ? 'rejected'
                        : undefined,
            riskLevel: analysis.riskLevel,
            reason: analysis.summary.slice(0, 500),
        })
    }

    const handleReview = async (input: RiskReviewInput) => {
        if (!analysis || !canReview) return

        try {
            await review.mutateAsync({
                analysisId: analysis.id,
                input,
            })
            message.success('人工审核结论已保存')
            onClose()
        } catch {
            // 保留表单输入，错误通过 review.error 展示。
        }
    }

    return (
        <Drawer
            open
            title={`Agent 资料审核 · ${batch.herbName}`}
            className="risk-workbench"
            size={640}
            closable={!review.isPending}
            keyboard={!review.isPending}
            mask={{ closable: !review.isPending }}
            onClose={handleClose}
        >
            <Space
                orientation="vertical"
                size="middle"
                style={{ width: '100%' }}
            >
                <Space wrap>
                    <Text copyable>{batch.batchNo}</Text>
                    <AuditTag status={batch.auditStatus} />
                    <StageTag stage={batch.stage} />
                </Space>

                <Alert
                    type="info"
                    showIcon
                    title="AI 提供资料审核建议，最终结论由管理员确认"
                    description="当前检查资料完整性与一致性，不代表完成药物安全检测。"
                />

                <div className="risk-workbench__flow">
                    只读工具取数 → 规则检查与模型判断 → 校验并保存建议 → 人工确认
                    <Text type="secondary">打开窗口只读取已保存建议；点击分析才调用模型，不会自动通过或驳回。</Text>
                </div>

                <Space wrap>
                    {/* 请求期间出现停止按钮；停止后的状态确认完成前，仍由 mutation 保持防重复提交。 */}
                    <Button
                        type="primary"
                        icon={<RobotOutlined />}
                        loading={analyze.isPending}
                        disabled={!canAnalyze}
                        onClick={handleAnalyze}
                    >
                        {analysis ? '重新分析' : '开始风险分析'}
                    </Button>

                    {analyze.isPending && (
                        <Button
                            danger
                            disabled={stopped}
                            onClick={stopAnalyze}
                        >
                            {stopped ? '停止已请求' : '停止分析'}
                        </Button>
                    )}
                </Space>

                {analyzeReason && <Text type="secondary" role="status">{analyzeReason}</Text>}

                {query.isPending && <Spin />}

                {query.error && (
                    <Alert
                        type="error"
                        showIcon
                        title={query.error.message}
                        action={
                            <Button onClick={() => void query.refetch()}>
                                重试读取
                            </Button>
                        }
                    />
                )}

                {operationError && (
                    <Alert
                        type="error"
                        showIcon
                        title={operationError.message}
                        action={
                            analysisError ? (
                                <Button
                                    disabled={!canAnalyze}
                                    onClick={handleAnalyze}
                                >
                                    重新分析
                                </Button>
                            ) : undefined
                        }
                    />
                )}

                {stopped && (
                    <Alert
                        type="warning"
                        showIcon
                        title="已请求停止分析"
                        description="停止不会撤销已经保存的建议；系统会重新查询最近保存的结果。"
                    />
                )}

                {analyze.isPending && (
                    <Text type="secondary">
                        {stopped
                            ? '正在停止连接并确认保存状态。'
                            : '正在分析，最长约一分钟。下方展示实际阶段事件。'}
                    </Text>
                )}

                {analysis && analyze.isPending && (
                    <Text type="secondary">
                        下方分析报告仍是上一份已保存建议，新建议成功后会替换。
                    </Text>
                )}

                {progress.length > 0 && (
                    <details className="risk-workbench__process" open={analyze.isPending}>
                        <summary>本次运行过程（{progress.length} 个阶段事件）</summary>
                        <Text type="secondary">这里是实际工具与保存步骤，不是模型思维链或正文逐字输出。</Text>

                        <Timeline
                            items={progress.map((item) => ({
                                key: item.seq,
                                color:
                                    item.status === 'completed'
                                        ? 'green'
                                        : 'blue',
                                content: (
                                    <Space orientation="vertical" size={4}>
                                        <Text strong>{riskProgressLabel(item)}</Text>
                                        <Space wrap>
                                            <Tag>
                                                {item.status === 'completed'
                                                    ? '完成事件'
                                                    : '开始事件'}
                                            </Tag>

                                            {item.toolName && (
                                                <Text code>{item.toolName}</Text>
                                            )}
                                        </Space>
                                    </Space>
                                ),
                            }))}
                        />
                    </details>
                )}

                {!query.isPending &&
                    !query.error &&
                    !analyze.isPending &&
                    !analysis && (
                        <Empty description={batch.auditStatus === 'pending'
                            ? '尚无建议。点击开始风险分析，查看工具、依据和审核建议。'
                            : '该批次没有保存过 Agent 建议；已审核批次不能补跑分析。'} />
                    )}

                {analysis && (
                    <>
                        <Title level={5}>已保存的审核建议</Title>
                        <Space wrap>
                            <RiskTag level={analysis.riskLevel} />
                            <Tag>
                                {RECOMMENDATION_LABEL[analysis.recommendation]}
                            </Tag>
                            {analysis.mode === 'demo' && (
                                <Tag color="orange">本地规则演示</Tag>
                            )}
                        </Space>

                        <Text type="secondary">
                            模型：{analysis.modelName} · 依据版本 v{analysis.basedOnVersion} · {analysis.promptVersion}
                        </Text>

                        <Text type="secondary">风险等级是本轮资料建议，不会直接修改批次风险标记。请对照下面资料核对判断。</Text>

                        <Paragraph>{analysis.summary}</Paragraph>

                        {analysis.stale && (
                            <Alert
                                type="warning"
                                showIcon
                                title="批次已经变化或完成审核，这份建议不能继续提交"
                            />
                        )}

                        {analysis.missingInformation.length > 0 && (
                            <Alert
                                type="warning"
                                title={analysis.promptVersion === 'audit-risk-v2' ? '当前阶段规则发现的缺失资料' : '需要补充或人工核对的资料'}
                                description={
                                    <ul>
                                        {analysis.missingInformation.map((item) => (
                                            <li key={item}>{item}</li>
                                        ))}
                                    </ul>
                                }
                            />
                        )}

                        <Title level={5}>已完成的工具调用</Title>
                        <Timeline
                            items={analysis.toolCalls.map((call, index) => ({
                                key: `${call.name}-${index}`,
                                color: 'green',
                                content: <Space orientation="vertical" size={2}>
                                    <Text strong>{RISK_TOOL_LABEL[call.name]}</Text>
                                    <Text>{call.summary}</Text>
                                    <Text code>{call.name}</Text>
                                </Space>,
                            }))}
                        />

                        {analysis.promptVersion === 'audit-risk-v2' && analysis.missingInformation.length === 0 && (
                            <Text type="secondary">当前阶段必需项均已登记；这不排除文字矛盾，也不证明资料真实或药材安全。</Text>
                        )}

                        <Title level={5}>判断与资料对照（{analysis.evidence.length} 条）</Title>
                        {analysis.evidence.map((item, index) => (
                            <div className="risk-workbench__evidence" key={`${item.sourceId}-${index}`}>
                                <Text strong>{index + 1}. {riskEvidenceLabel(item.sourceId)}</Text>
                                <Paragraph>模型判断：{item.note}</Paragraph>
                                {item.sourceText !== undefined ? (
                                    <Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                        服务端提供的资料：{item.sourceText}
                                    </Paragraph>
                                ) : (
                                    <Text type="secondary">旧建议未保存原文快照，请对照批次档案核对。</Text>
                                )}
                                <details><summary>技术来源标识</summary><Text code>{item.sourceId}</Text></details>
                            </div>
                        ))}

                        <Divider />

                        <Title level={5}>人工审核结论</Title>
                        <Text type="secondary">填入建议只预填表单，不会提交；“需要人工复核”不会替你选择通过或驳回。</Text>
                        <Button
                            disabled={!canReview}
                            onClick={fillSuggestion}
                        >
                            将建议填入表单
                        </Button>

                        {reviewReason && <Text type="secondary" role="status">{reviewReason}</Text>}

                        <Form<RiskReviewInput>
                            form={form}
                            layout="vertical"
                            disabled={!canReview}
                            onFinish={handleReview}
                        >
                            <Form.Item
                                name="decision"
                                label="最终结论"
                                rules={[{
                                    required: true,
                                    message: '请选择最终结论',
                                }]}
                            >
                                <Select
                                    options={[
                                        { value: 'approved', label: '审核通过' },
                                        { value: 'rejected', label: '驳回' },
                                    ]}
                                />
                            </Form.Item>

                            <Form.Item
                                name="riskLevel"
                                label="最终风险等级"
                                rules={[{
                                    required: true,
                                    message: '请选择风险等级',
                                }]}
                            >
                                <Select
                                    options={Object.entries(RISK_LABEL).map(
                                        ([value, label]) => ({ value, label }),
                                    )}
                                />
                            </Form.Item>

                            <Form.Item
                                name="reason"
                                label="审核理由"
                                rules={[{
                                    required: true,
                                    whitespace: true,
                                    message: '请填写审核理由',
                                }]}
                            >
                                <Input.TextArea
                                    rows={4}
                                    maxLength={500}
                                    showCount
                                />
                            </Form.Item>

                            <Button
                                type="primary"
                                htmlType="submit"
                                loading={review.isPending}
                                disabled={!canReview}
                            >
                                确认并保存人工结论
                            </Button>
                        </Form>
                    </>
                )}
            </Space>
        </Drawer>
    )
}
