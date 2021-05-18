import {
    Dimension,
    FilterGroup,
    Direction,
    Explore,
    ExploreJoin,
    fieldId,
    FilterGroupOperator,
    Measure,
    MetricQuery, StringFilter, StringDimension, NumberDimension, NumberFilter,
} from "common";


const lightdashVariablePattern = /\$\{([a-zA-Z0-9_.]+)\}/g

const renderDimensionReference = (ref: string, explore: Explore, currentTable: string): string => {
    // Reference to current table
    if (ref === 'TABLE') {
        return currentTable
    }
    // Reference to another dimension
    const split = ref.split('.')
    if (split.length > 2) {
        throw new Error(`Model ${currentTable} has an illegal dimension reference: \${${ref}}`)
    }
    const refTable = split.length === 1 ? currentTable : split[0]
    const refName = split.length === 1 ? split[0] : split[1]
    const dimension = explore.tables[refTable]?.dimensions[refName]
    if (dimension === undefined)
        throw Error(`Model ${currentTable} has a dimension reference: \${${ref}} which matches no dimension`)
    return `(${renderDimensionSql(dimension, explore)})`
}

const renderMeasureReference = (ref: string, explore: Explore, currentTable: string): string => {
    // Reference to current table
    if (ref === 'TABLE') {
        return currentTable
    }
    // Reference to another dimension
    const split = ref.split('.')
    if (split.length > 2) {
        throw new Error(`Model ${currentTable} has an illegal measure reference: \${${ref}}`)
    }
    const refTable = split.length === 1 ? currentTable : split[0]
    const refName = split.length === 1 ? split[0] : split[1]
    const measure = explore.tables[refTable]?.measures[refName]
    if (measure === undefined)
        throw Error(`Model ${currentTable} has a measure reference: \${${ref}} which matches no measure`)
    return `(${renderMeasureSql(measure, explore)})`
}

const renderMeasureSql = (measure: Measure, explore: Explore): string => {
    // Measure might have references to other dimensions
    const renderedSql = measure.sql.replace(lightdashVariablePattern, (_, p1) => renderDimensionReference(p1, explore, measure.table))
    const measureType = measure.type
    switch(measureType) {
        case "average": return `AVG(${renderedSql})`
        case "count":   return `COUNT(${renderedSql})`
        case "count_distinct": return `COUNT(DISTINCT ${renderedSql})`
        case "max": return `MAX(${renderedSql})`
        case "min": return `MIN(${renderedSql})`
        case "sum": return `SUM(${renderedSql})`
        default:
            const nope: never = measureType
            throw Error(`No SQL render function implemented for measure with type ${measure.type}`)
    }
}


const renderDimensionSql = (dimension: Dimension, explore: Explore): string => {
    // Dimension might have references to other dimensions
    return dimension.sql.replace(lightdashVariablePattern, (_, p1) => renderDimensionReference(p1, explore, dimension.table))
}

const renderExploreJoinSql = (join: ExploreJoin, explore: Explore): string => {
    // Sql join contains references to dimensions
    return join.sqlOn.replace(lightdashVariablePattern, (_, p1) => renderDimensionReference(p1, explore, join.table))
}

const renderStringFilterSql = (dimension: StringDimension, filter: StringFilter, explore: Explore): string => {
    const dimensionSql = renderDimensionSql(dimension, explore)
    const filterType = filter.operator
    switch (filter.operator) {
        case "equals":
            return filter.values.length === 0 ? 'false' : `(${dimensionSql}) IN (${filter.values.map(v => `'${v}'`).join(',')})`
        case "notEquals":
            return filter.values.length === 0 ? 'true' : `(${dimensionSql}) NOT IN (${filter.values.map(v => `'${v}'`).join(',')})`
        case "isNull":
            return `(${dimensionSql}) IS NULL`
        case "notNull":
            return `(${dimensionSql}) IS NOT NULL`
        case "startsWith":
            return `(${dimensionSql}) LIKE '${filter.value}%'`
        default:
            const nope: never = filter
            throw Error(`No function implemented to render sql for filter type ${filterType} on dimension type ${dimension.type}`)
    }
}

const renderNumberFilterSql = (dimension: NumberDimension, filter: NumberFilter, explore: Explore): string => {
    const dimensionSql = renderDimensionSql(dimension, explore)
    const filterType = filter.operator
    switch (filter.operator) {
        case "equals":
            return filter.values.length === 0 ? 'false' : `(${dimensionSql}) IN (${filter.values.join(',')})`
        case "notEquals":
            return filter.values.length === 0 ? 'true' : `(${dimensionSql}) NOT IN (${filter.values.join(',')})`
        case "isNull":
            return `(${dimensionSql}) IS NULL`
        case "notNull":
            return `(${dimensionSql}) IS NOT NULL`
        case "greaterThan":
            return `(${dimensionSql}) > ${filter.value}`
        case "lessThan":
            return `(${dimensionSql}) < ${filter.value}`
        default:
            const nope: never = filter
            throw Error(`No function implemented to render sql for filter type ${filterType} on dimension type ${dimension.type}`)
    }
}

const renderFilterGroupSql = (filterGroup: FilterGroup, explore: Explore): string => {
    const operator = filterGroup.operator === FilterGroupOperator.or ? 'OR' : 'AND'
    const groupType = filterGroup.type
    switch (filterGroup.type) {
        case "string":
            return filterGroup.filters.map(filter => renderStringFilterSql(filterGroup.dimension, filter, explore)).join(`\n   ${operator} `)
        case "number":
            return filterGroup.filters.map(filter => renderNumberFilterSql(filterGroup.dimension, filter, explore)).join(`\n   ${operator} `)
        default:
            const nope: never = filterGroup
            throw Error(`No function implemented to render sql for filter group type ${groupType}`)

    }
}


export const buildQuery = ({ explore, dimensions, measures, filters, sorts, limit }: MetricQuery) => {
    const baseTable = explore.tables[explore.baseTable].sqlTable
    const sqlFrom = `FROM ${baseTable} AS ${explore.baseTable}`
    const sqlJoins = explore.joinedTables.map(join => {
        const joinTable = explore.tables[join.table].sqlTable
        const alias = join.table
        return `LEFT JOIN ${joinTable} AS ${alias}\n  ON ${renderExploreJoinSql(join, explore)}`
    })

    const dimensionSelects = dimensions.map(field => {
        const dimension = explore.tables[field.table].dimensions[field.name]
        const alias = fieldId(field)
        return `  ${renderDimensionSql(dimension, explore)} AS \`${alias}\``
    })

    const measureSelects = measures.map(field => {
        const measure = explore.tables[field.table].measures[field.name]
        const alias = fieldId(field)
        return `  ${renderMeasureSql(measure, explore)} AS \`${alias}\``
    })

    const sqlSelect = `SELECT\n${[...dimensionSelects, ...measureSelects].join(',\n')}`
    const sqlGroupBy = dimensionSelects.length > 0 ? `GROUP BY ${dimensionSelects.map((val, i) => i+1).join(',')}`: ''

    const fieldOrders = sorts.map(sort => `${fieldId(sort.field)}${sort.direction === Direction.descending ? ' DESC' : ''}`)
    const sqlOrderBy = fieldOrders.length > 0 ? `ORDER BY ${fieldOrders.join(', ')}` : ''

    const whereFilters = filters.map(filter => renderFilterGroupSql(filter, explore))
    const sqlWhere = whereFilters.length > 0 ? `WHERE ${whereFilters.map(w => `(\n  ${w}\n)`).join(' AND ')}` : ''


    const sqlLimit = `LIMIT ${limit}`

    const sql = [sqlSelect, sqlFrom, sqlJoins, sqlWhere, sqlGroupBy, sqlOrderBy, sqlLimit].join('\n')
    return sql
}