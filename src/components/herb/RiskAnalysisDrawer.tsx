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
import { RiskTag } from './herbTags'

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
    const busy = analyze.isPending || review.isPending

    const operationError = analysisError ?? review.error

    useEffect(() => {
        // 包括“停止后重新查询到新建议”的情况，不能复用旧审核表单。
        if (analysis?.id) form.resetFields()
    }, [analysis?.id, form])

    const canReview = Boolean(
        analysis &&
        !analysis.stale &&
        batch.auditStatus === 'pending' &&
        query.isSuccess &&
        !query.isPaused &&
        !busy &&
        !query.isFetching,
    )

    const handleClose = () => {
        // 人工审核是业务写入，提交期间不关闭，避免结果不明确。
        if (review.isPending) return

        // 先取消尚未完成的分析，再通知父组件卸载抽屉。
        stopAnalyze()
        onClose()
    }



    const handleAnalyze = async () => {
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
            title={`风险审核 · ${batch.herbName}`}
            size={560}
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
                <Text type="secondary">{batch.batchNo}</Text>

                <Alert
                    type="info"
                    showIcon
                    title="AI 提供资料审核建议，最终结论由管理员确认"
                    description="当前检查资料完整性与一致性，不代表完成药物安全检测。"
                />

                <Space wrap>
                    {/* 请求期间出现停止按钮；停止后的状态确认完成前，仍由 mutation 保持防重复提交。 */}
                    <Button
                        type="primary"
                        icon={<RobotOutlined />}
                        loading={analyze.isPending}
                        disabled={
                            busy ||
                            query.isFetching ||
                            batch.auditStatus !== 'pending'
                        }
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
                                    disabled={
                                        busy ||
                                        query.isFetching ||
                                        batch.auditStatus !== 'pending'
                                    }
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
                    <>
                        <Title level={5}>本次分析过程</Title>

                        <Timeline
                            items={progress.map((item) => ({
                                key: item.seq,
                                color:
                                    item.status === 'completed'
                                        ? 'green'
                                        : 'blue',
                                title: item.message,
                                content: (
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
                                ),
                            }))}
                        />
                    </>
                )}

                {!query.isPending &&
                    !query.error &&
                    !analyze.isPending &&
                    !analysis && (
                        <Empty description="该批次暂无风险分析记录" />
                    )}

                {analysis && (
                    <>
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
                            模型：{analysis.modelName}
                        </Text>

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
                                title: call.summary,
                                content: <Text code>{call.name}</Text>,
                            }))}
                        />

                        <Title level={5}>判断依据</Title>
                        {analysis.evidence.map((item, index) => (
                            <div key={`${item.sourceId}-${index}`}>
                                <Text code>{item.sourceId}</Text>
                                <Paragraph>模型判断：{item.note}</Paragraph>
                                {item.sourceText !== undefined ? (
                                    <Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                        服务端提供的资料：{item.sourceText}
                                    </Paragraph>
                                ) : (
                                    <Text type="secondary">旧建议未保存原文快照，请对照批次档案核对。</Text>
                                )}
                            </div>
                        ))}

                        <Divider />

                        <Title level={5}>人工审核结论</Title>
                        <Button
                            disabled={!canReview}
                            onClick={fillSuggestion}
                        >
                            将建议填入表单
                        </Button>

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
